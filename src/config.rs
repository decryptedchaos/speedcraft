use std::env;

fn parse_int(key: &str, fallback: i64) -> i64 {
    env::var(key)
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or(fallback)
}

fn text(key: &str, fallback: &str) -> String {
    match env::var(key) {
        Ok(value) if !value.trim().is_empty() => value,
        _ => fallback.to_string(),
    }
}

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub port: u16,
    pub bind: String,
    pub static_dir: String,
    pub worker: WorkerConfig,
}

#[derive(Clone, Debug)]
pub struct WorkerConfig {
    pub provider: String,
    pub image: String,
    pub command: Vec<String>,
    pub workdir: String,
    pub network: String,
    pub port: u16,
    pub pool_size: usize,
    pub idle_ms: u64,
    pub max_bytes: u64,
    pub location: String,
    pub health_timeout_ms: u64,
    pub publish: bool,
    pub publish_host: String,
    pub socket: String,
}

#[derive(Clone, Debug)]
pub struct WorkerRuntimeConfig {
    pub port: u16,
    pub bind: String,
    pub max_bytes: u64,
    pub location: String,
}

impl AppConfig {
    pub fn from_env() -> Self {
        Self {
            port: parse_int("PORT", 3000).clamp(1, 65535) as u16,
            bind: text("BIND", "0.0.0.0"),
            static_dir: text("STATIC_DIR", "./assets"),
            worker: WorkerConfig::from_env(),
        }
    }
}

impl WorkerConfig {
    pub fn from_env() -> Self {
        let command = text("WORKER_COMMAND", "speedtest worker");
        Self {
            provider: text("WORKER_PROVIDER", "auto").to_lowercase(),
            image: text("WORKER_IMAGE", "speedtest:local"),
            command: command.split_whitespace().map(str::to_string).collect(),
            workdir: text("WORKER_WORKDIR", "/app"),
            network: text("WORKER_NETWORK", "speedtest-workers"),
            port: parse_int("WORKER_PORT", 8080).clamp(1, 65535) as u16,
            pool_size: parse_int("WORKER_POOL_SIZE", 3).max(1) as usize,
            idle_ms: parse_int("WORKER_IDLE_SECONDS", 120).max(10) as u64 * 1000,
            max_bytes: parse_int("WORKER_MAX_BYTES", 512 * 1024 * 1024).max(1) as u64,
            location: text("WORKER_LOCATION", "Local Docker Network"),
            health_timeout_ms: parse_int("WORKER_HEALTH_TIMEOUT_MS", 15000).max(1000) as u64,
            publish: text("WORKER_PUBLISH", "auto").to_lowercase() != "none",
            publish_host: text("WORKER_PUBLISH_HOST", "0.0.0.0"),
            socket: text("DOCKER_SOCKET", "/var/run/docker.sock"),
        }
    }
}

impl WorkerRuntimeConfig {
    pub fn from_env() -> Self {
        Self {
            port: parse_int("WORKER_PORT", 8080).clamp(0, 65535) as u16,
            bind: text("WORKER_BIND", "0.0.0.0"),
            max_bytes: parse_int("WORKER_MAX_BYTES", 512 * 1024 * 1024).max(1) as u64,
            location: text("WORKER_LOCATION", "Local Docker Network"),
        }
    }
}
