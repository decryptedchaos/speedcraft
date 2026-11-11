use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;

use crate::config::WorkerConfig;
use crate::docker::DockerEngine;

const OWNER_LABEL: &str = "speedtest.owned=true";
const MEMORY_BYTES: i64 = 256 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct WorkerHandle {
    pub id: String,
    pub mode: String,
    pub url: String,
    pub host_port: Option<u16>,
    pub label: String,
}

struct Slot {
    handle: WorkerHandle,
    healthy: bool,
    last_used: Instant,
    inflight: u32,
    child: Option<tokio::process::Child>,
}

struct Inner {
    slots: HashMap<String, Slot>,
    assignments: HashMap<String, String>,
    warning: Option<String>,
}

pub struct Pool {
    cfg: WorkerConfig,
    engine: DockerEngine,
    inner: Mutex<Inner>,
    spawn_lock: Mutex<()>,
    stopped: AtomicBool,
    provider: String,
}

impl Pool {
    /// Decides the provider before anyone asks for a worker, so `/healthz` can
    /// report the truth immediately after start.
    pub async fn new(cfg: WorkerConfig) -> Arc<Self> {
        let engine = DockerEngine::new(cfg.socket.clone());
        let mut provider = "native".to_string();
        let mut warning: Option<String> = None;

        if cfg.provider != "native" {
            match engine.ping().await {
                Ok(()) => provider = "docker".to_string(),
                Err(err) => {
                    if cfg.provider == "docker" {
                        provider = "docker".to_string();
                        warning = Some(format!(
                            "docker engine unreachable at {}: {err}",
                            cfg.socket
                        ));
                    } else {
                        warning = Some(format!(
                            "docker engine unreachable ({err}); running test workers as local processes"
                        ));
                    }
                }
            }
        }

        if provider == "docker" {
            if !engine.image_exists(&cfg.image).await.unwrap_or(false) {
                warning = Some(format!(
                    "worker image \"{}\" is not built yet; run \"docker compose build\"",
                    cfg.image
                ));
            }
            match engine.list_by_label(OWNER_LABEL).await {
                Ok(containers) => {
                    for container in containers {
                        if let Some(id) = container.get("Id").and_then(Value::as_str) {
                            eprintln!(
                                "[workers] removing orphaned worker {}",
                                short(id)
                            );
                            let _ = engine.remove(id).await;
                        }
                    }
                }
                Err(err) => eprintln!("[workers] orphan cleanup skipped: {err}"),
            }
        }

        if let Some(message) = &warning {
            eprintln!("[workers] {message}");
        }
        eprintln!(
            "[workers] provider={} pool={} idle={}s{}{}",
            provider,
            cfg.pool_size,
            cfg.idle_ms / 1000,
            if provider == "docker" {
                format!(" image={} network={}", cfg.image, cfg.network)
            } else {
                String::new()
            },
            if cfg.publish && provider == "docker" {
                format!(" publish={}", cfg.publish_host)
            } else {
                String::new()
            }
        );

        Arc::new(Self {
            cfg,
            engine,
            inner: Mutex::new(Inner {
                slots: HashMap::new(),
                assignments: HashMap::new(),
                warning,
            }),
            spawn_lock: Mutex::new(()),
            stopped: AtomicBool::new(false),
            provider,
        })
    }

    pub fn start_sweeper(self: &Arc<Self>) {
        let pool = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                if pool.stopped.load(Ordering::SeqCst) {
                    break;
                }
                pool.sweep().await;
            }
        });
    }

    pub async fn acquire(&self, session: Option<&str>) -> Result<WorkerHandle, String> {
        if self.stopped.load(Ordering::SeqCst) {
            return Err("the worker pool is shutting down".to_string());
        }

        let existing = {
            let mut inner = self.inner.lock().await;
            if let Some(sid) = session {
                if let Some(id) = inner.assignments.get(sid).cloned() {
                    if let Some(slot) = inner.slots.get_mut(&id) {
                        if slot.healthy {
                            slot.last_used = Instant::now();
                            return Ok(slot.handle.clone());
                        }
                    }
                }
            }
            let mut alive: Vec<(Instant, WorkerHandle)> = inner
                .slots
                .values()
                .filter(|slot| slot.healthy)
                .map(|slot| (slot.last_used, slot.handle.clone()))
                .collect();
            alive.sort_by_key(|(last_used, _)| *last_used);
            alive.into_iter().next().map(|(_, handle)| handle)
        };

        let worker = match existing {
            Some(handle) => handle,
            None => self.spawn().await?,
        };

        let mut inner = self.inner.lock().await;
        if session.is_some() {
            if inner.assignments.len() > 5000 {
                inner.assignments.clear();
            }
            inner
                .assignments
                .insert(session.unwrap().to_string(), worker.id.clone());
        }
        if let Some(slot) = inner.slots.get_mut(&worker.id) {
            slot.last_used = Instant::now();
        }
        Ok(worker)
    }

    /// Marks a worker as busy so the idle sweep cannot remove it mid-transfer.
    pub async fn hold(&self, id: &str) {
        let mut inner = self.inner.lock().await;
        if let Some(slot) = inner.slots.get_mut(id) {
            slot.inflight += 1;
            slot.last_used = Instant::now();
        }
    }

    pub async fn release(&self, id: &str) {
        let mut inner = self.inner.lock().await;
        if let Some(slot) = inner.slots.get_mut(id) {
            slot.inflight = slot.inflight.saturating_sub(1);
            slot.last_used = Instant::now();
        }
    }

    async fn spawn(&self) -> Result<WorkerHandle, String> {
        let _guard = self.spawn_lock.lock().await;

        // Another request may have spawned while this one waited for the lock.
        if let Some(handle) = {
            let inner = self.inner.lock().await;
            inner
                .slots
                .values()
                .find(|slot| slot.healthy)
                .map(|slot| slot.handle.clone())
        } {
            return Ok(handle);
        }

        if self.stopped.load(Ordering::SeqCst) {
            return Err("the worker pool is shutting down".to_string());
        }

        self.make_room().await;

        let slot = if self.provider == "docker" {
            self.spawn_docker().await?
        } else {
            self.spawn_native().await?
        };
        let handle = slot.handle.clone();
        let mut inner = self.inner.lock().await;
        inner.slots.insert(handle.id.clone(), slot);
        eprintln!("[workers] started {} worker {}", handle.mode, handle.url);
        Ok(handle)
    }

    async fn make_room(&self) {
        if self.cfg.pool_size == 0 {
            return;
        }
        let evicted = {
            let mut inner = self.inner.lock().await;
            if inner.slots.len() < self.cfg.pool_size {
                return;
            }
            let victim = inner
                .slots
                .values()
                .filter(|slot| slot.inflight == 0)
                .min_by_key(|slot| slot.last_used)
                .map(|slot| slot.handle.clone());
            match victim {
                Some(handle) => inner.slots.remove(&handle.id).map(|slot| (handle, slot)),
                None => None,
            }
        };
        if let Some((handle, slot)) = evicted {
            self.release_slot(handle, slot).await;
        }
    }

    async fn spawn_docker(&self) -> Result<Slot, String> {
        let cfg = &self.cfg;

        let mut host_config = json!({
            "NetworkMode": cfg.network,
            "ReadonlyRootfs": true,
            "Memory": MEMORY_BYTES,
            "MemorySwap": MEMORY_BYTES,
            "NanoCpus": 1_000_000_000i64,
            "PidsLimit": 64,
            "CapDrop": ["ALL"],
            "SecurityOpt": ["no-new-privileges"],
        });
        if cfg.publish {
            host_config["PortBindings"] = json!({
                format!("{}/tcp", cfg.port): [
                    { "HostIp": cfg.publish_host, "HostPort": "" }
                ]
            });
        }

        let spec = json!({
            "Image": cfg.image,
            // Same image as the app, different subcommand: that is a worker.
            "Cmd": cfg.command,
            "WorkingDir": cfg.workdir,
            "Env": [
                format!("WORKER_PORT={}", cfg.port),
                format!("WORKER_LOCATION={}", cfg.location),
                format!("WORKER_MAX_BYTES={}", cfg.max_bytes),
            ],
            "Labels": { "speedtest.owned": "true", "speedtest.role": "worker" },
            "ExposedPorts": { format!("{}/tcp", cfg.port): {} },
            "HostConfig": host_config,
        });

        let id = self.engine.create_container(&spec).await?;
        let started = async {
            self.engine.start(&id).await?;
            let address = self.wait_for_address(&id).await?;
            let url = format!("http://{address}:{}", cfg.port);
            self.wait_for_health(&url).await?;
            let host_port = self.host_port(&id).await;
            Ok::<(String, Option<u16>), String>((url, host_port))
        }
        .await;

        let (url, host_port) = match started {
            Ok(value) => value,
            Err(err) => {
                let _ = self.engine.remove(&id).await;
                return Err(format!("could not start a test worker container: {err}"));
            }
        };

        Ok(Slot {
            handle: WorkerHandle {
                id,
                mode: "docker".to_string(),
                url,
                host_port,
                label: cfg.location.clone(),
            },
            healthy: true,
            last_used: Instant::now(),
            inflight: 0,
            child: None,
        })
    }

    async fn wait_for_address(&self, id: &str) -> Result<String, String> {
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline {
            if let Ok(info) = self.engine.inspect(id).await {
                if let Some(address) = info
                    .pointer("/NetworkSettings/Networks")
                    .and_then(|networks| networks.get(&self.cfg.network))
                    .and_then(|network| network.get("IPAddress"))
                    .and_then(Value::as_str)
                {
                    if !address.is_empty() {
                        return Ok(address.to_string());
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        Err(format!(
            "worker container never joined network {}",
            self.cfg.network
        ))
    }

    async fn host_port(&self, id: &str) -> Option<u16> {
        let info = self.engine.inspect(id).await.ok()?;
        info.pointer("/NetworkSettings/Ports")
            .and_then(|ports| ports.get(format!("{}/tcp", self.cfg.port)))
            .and_then(Value::as_array)
            .and_then(|bindings| bindings.first())
            .and_then(|binding| binding.get("HostPort"))
            .and_then(Value::as_str)
            .and_then(|port| port.parse::<u16>().ok())
    }

    async fn spawn_native(&self) -> Result<Slot, String> {
        let exe = std::env::current_exe().map_err(|err| err.to_string())?;
        let mut child = tokio::process::Command::new(exe)
            .arg("worker")
            .env("WORKER_PORT", "0")
            .env("WORKER_BIND", "127.0.0.1")
            .env("WORKER_LOCATION", &self.cfg.location)
            .env("WORKER_MAX_BYTES", self.cfg.max_bytes.to_string())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|err| format!("could not start a local worker: {err}"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "local worker produced no output".to_string())?;
        let mut lines = BufReader::new(stdout).lines();

        let port = tokio::time::timeout(
            Duration::from_millis(self.cfg.health_timeout_ms),
            async {
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(rest) = line.strip_prefix("LISTENING ") {
                        if let Ok(port) = rest.trim().parse::<u16>() {
                            return Ok(port);
                        }
                    }
                }
                Err("local worker exited before reporting a port".to_string())
            },
        )
        .await
        .map_err(|_| "local worker did not report a port in time".to_string())??;

        // Keep draining so the child never blocks on a full stdout pipe.
        tokio::spawn(async move {
            while let Ok(Some(_)) = lines.next_line().await {}
        });

        let url = format!("http://127.0.0.1:{port}");
        if let Err(err) = self.wait_for_health(&url).await {
            return Err(err);
        }

        Ok(Slot {
            handle: WorkerHandle {
                id: format!("local-{port}"),
                mode: "native".to_string(),
                url,
                host_port: None,
                label: self.cfg.location.clone(),
            },
            healthy: true,
            last_used: Instant::now(),
            inflight: 0,
            child: Some(child),
        })
    }

    async fn wait_for_health(&self, url: &str) -> Result<(), String> {
        let client = crate::http_client();
        let deadline = Instant::now() + Duration::from_millis(self.cfg.health_timeout_ms);
        let mut last_error = String::from("timeout");
        while Instant::now() < deadline {
            match client
                .get(format!("{url}/health"))
                .timeout(Duration::from_secs(2))
                .send()
                .await
            {
                Ok(response) if response.status().is_success() => return Ok(()),
                Ok(response) => last_error = format!("health returned {}", response.status()),
                Err(err) => last_error = err.to_string(),
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        Err(format!("test worker did not become healthy: {last_error}"))
    }

    pub async fn invalidate(&self, id: &str) {
        let slot = {
            let mut inner = self.inner.lock().await;
            inner.assignments.retain(|_, worker_id| worker_id != id);
            inner.slots.remove(id)
        };
        if let Some(slot) = slot {
            let handle = slot.handle.clone();
            self.release_slot(handle, slot).await;
        }
    }

    async fn release_slot(&self, handle: WorkerHandle, slot: Slot) {
        let result = if handle.mode == "docker" {
            self.engine.remove(&handle.id).await
        } else if let Some(mut child) = slot.child {
            match child.start_kill() {
                Ok(()) => Ok(()),
                Err(err) => Err(err.to_string()),
            }
        } else {
            Ok(())
        };
        if let Err(err) = result {
            eprintln!("[workers] failed to stop worker {}: {err}", short(&handle.id));
        }
    }

    async fn sweep(&self) {
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        let doomed = {
            let mut inner = self.inner.lock().await;
            let stale: Vec<String> = inner
                .slots
                .values()
                .filter(|slot| {
                    slot.inflight == 0
                        && (!slot.healthy || slot.last_used.elapsed() > Duration::from_millis(self.cfg.idle_ms))
                })
                .map(|slot| slot.handle.id.clone())
                .collect();
            let mut removed = Vec::new();
            for id in stale {
                inner.assignments.retain(|_, worker_id| worker_id != &id);
                if let Some(slot) = inner.slots.remove(&id) {
                    removed.push(slot);
                }
            }
            removed
        };
        for slot in doomed {
            let handle = slot.handle.clone();
            self.release_slot(handle, slot).await;
        }
    }

    pub async fn stats(&self) -> Value {
        let inner = self.inner.lock().await;
        let docker = self.provider == "docker";
        json!({
            "provider": self.provider,
            "socket": if docker { Some(self.cfg.socket.clone()) } else { None },
            "image": if docker { Some(self.cfg.image.clone()) } else { None },
            "network": if docker { Some(self.cfg.network.clone()) } else { None },
            "location": self.cfg.location,
            "poolSize": self.cfg.pool_size,
            "idleSeconds": self.cfg.idle_ms / 1000,
            "publishWorkers": self.cfg.publish && docker,
            "workers": inner.slots.len(),
            "sessions": inner.assignments.len(),
            "warning": inner.warning,
        })
    }

    pub async fn shutdown(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        let all = {
            let mut inner = self.inner.lock().await;
            inner.assignments.clear();
            inner.slots.drain().map(|(_, slot)| slot).collect::<Vec<_>>()
        };
        for slot in all {
            let handle = slot.handle.clone();
            self.release_slot(handle, slot).await;
        }
    }
}

pub fn short(id: &str) -> String {
    id.chars().take(12).collect()
}
