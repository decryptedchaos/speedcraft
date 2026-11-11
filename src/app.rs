use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::Router;
use bytes::Bytes;
use serde_json::json;

use crate::config::AppConfig;
use crate::pool::{short, Pool, WorkerHandle};

const SESSION_COOKIE: &str = "st_sid";
const HOP_BY_HOP: [&str; 9] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    // A proxy answers Expect itself; forwarding it stalls the upstream client
    // until a 100 Continue that may never arrive.
    "expect",
];

struct AppState {
    pool: Arc<Pool>,
    client: reqwest::Client,
    assets: HashMap<String, (Bytes, &'static str)>,
    started: Instant,
}

pub async fn run() -> Result<(), String> {
    let cfg = AppConfig::from_env();
    let assets = load_assets(&cfg.static_dir)?;
    let pool = Pool::new(cfg.worker.clone()).await;
    pool.start_sweeper();

    let state = Arc::new(AppState {
        client: crate::http_client(),
        assets,
        started: Instant::now(),
        pool: Arc::clone(&pool),
    });

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/__speed/meta", get(meta))
        .route("/__speed/:kind", any(proxy))
        .fallback(static_handler)
        .with_state(Arc::clone(&state));

    let listener = tokio::net::TcpListener::bind((cfg.bind.as_str(), cfg.port))
        .await
        .map_err(|err| format!("could not bind {}:{}: {err}", cfg.bind, cfg.port))?;

    println!(
        "speed test app listening on http://{}:{}",
        cfg.bind, cfg.port
    );

    let result = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(crate::worker::shutdown_signal())
    .await
    .map_err(|err| err.to_string());

    eprintln!("[app] stopping test workers");
    pool.shutdown().await;
    result
}

fn load_assets(dir: &str) -> Result<HashMap<String, (Bytes, &'static str)>, String> {
    let mut assets = HashMap::new();
    for (path, kind) in [
        ("index.html", "text/html; charset=utf-8"),
        ("about.html", "text/html; charset=utf-8"),
        ("app.js", "application/javascript; charset=utf-8"),
        ("styles.css", "text/css; charset=utf-8"),
        ("favicon.ico", "image/x-icon"),
        ("static/img/brand.svg", "image/svg+xml"),
    ] {
        let file = std::path::Path::new(dir).join(path);
        match std::fs::read(&file) {
            Ok(data) => {
                assets.insert(path.to_string(), (Bytes::from(data), kind));
            }
            Err(err) => eprintln!("[app] missing asset {}: {err}", file.display()),
        }
    }
    if !assets.contains_key("index.html") {
        return Err(format!("no index.html in static dir {dir}"));
    }
    Ok(assets)
}

async fn healthz(State(state): State<Arc<AppState>>) -> Response {
    let mut payload = state.pool.stats().await;
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            "ok".to_string(),
            json!(true),
        );
        object.insert(
            "uptimeSeconds".to_string(),
            json!(state.started.elapsed().as_secs()),
        );
    }
    json_response(StatusCode::OK, payload)
}

async fn meta(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
) -> Response {
    let (sid, is_new) = session_of(&headers);
    let worker = match state.pool.acquire(Some(&sid)).await {
        Ok(worker) => worker,
        Err(err) => {
            return json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({ "error": "worker-unavailable", "message": err }),
            )
        }
    };

    let ip = client_ip(&headers, Some(address));
    let mut response = json_response(
        StatusCode::OK,
        json!({
            "protocol": if ip.contains(':') { "IPv6" } else { "IPv4" },
            "clientIp": ip,
            "serverLabel": worker.label,
            "workerId": short(&worker.id),
            "workerMode": worker.mode,
            "location": worker.label,
            // Direct origin for the browser when the worker published a port;
            // null means the page measures through this proxy.
            "workerOrigin": worker.host_port.map(|port| format!("http://{}:{port}", host_name(&headers))),
        }),
    );
    if is_new {
        if let Ok(value) = HeaderValue::from_str(&session_cookie(&sid)) {
            response.headers_mut().insert(header::SET_COOKIE, value);
        }
    }
    response
}

async fn proxy(State(state): State<Arc<AppState>>, request: Request<Body>) -> Response {
    let (sid, is_new) = session_of(request.headers());
    let method = request.method().clone();
    let uri = request.uri().clone();
    let headers = request.headers().clone();
    let bodyless = method == Method::GET || method == Method::HEAD;
    let mut body = if bodyless {
        None
    } else {
        Some(request.into_body())
    };

    let attempts = if bodyless { 2 } else { 1 };
    let mut last_error = String::from("the test worker could not be reached");

    for attempt in 0..attempts {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
        let worker = match state.pool.acquire(Some(&sid)).await {
            Ok(worker) => worker,
            Err(err) => {
                return json_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    json!({ "error": "worker-unavailable", "message": err }),
                )
            }
        };

        state.pool.hold(&worker.id).await;
        let outcome = forward(
            &state.client,
            &worker,
            &method,
            &uri,
            &headers,
            body.take(),
            &sid,
            is_new,
        )
        .await;
        state.pool.release(&worker.id).await;

        match outcome {
            Ok(response) => return response,
            Err(err) => {
                last_error = err;
                state.pool.invalidate(&worker.id).await;
            }
        }
    }

    json_response(
        StatusCode::BAD_GATEWAY,
        json!({ "error": "worker-unreachable", "message": last_error }),
    )
}

#[allow(clippy::too_many_arguments)]
async fn forward(
    client: &reqwest::Client,
    worker: &WorkerHandle,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    body: Option<Body>,
    sid: &str,
    is_new: bool,
) -> Result<Response, String> {
    let target = format!(
        "{}{}",
        worker.url,
        uri.path_and_query().map(|value| value.as_str()).unwrap_or("/")
    );

    let mut outgoing = HeaderMap::new();
    for (name, value) in headers {
        let lower = name.as_str().to_ascii_lowercase();
        if HOP_BY_HOP.contains(&lower.as_str()) || lower == "cookie" || lower == "host" {
            continue;
        }
        outgoing.insert(name.clone(), value.clone());
    }
    if let Some(ip) = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Ok(value) = HeaderValue::from_str(ip) {
            outgoing.insert("x-client-ip", value.clone());
            outgoing.insert("x-forwarded-for", value);
        }
    }
    if let Some(host) = uri.authority().map(|authority| authority.to_string()) {
        if let Ok(value) = HeaderValue::from_str(&host) {
            outgoing.insert(header::HOST, value);
        }
    } else if let Ok(value) = HeaderValue::from_str(&worker.url) {
        outgoing.insert(header::HOST, value);
    }

    let mut builder = client.request(method.clone(), target).headers(outgoing);
    if let Some(body) = body {
        builder = builder.body(reqwest::Body::wrap_stream(body.into_data_stream()));
    }

    let upstream = builder.send().await.map_err(|err| err.to_string())?;
    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();

    let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
    *response.status_mut() = status;
    let out = response.headers_mut();
    for (name, value) in upstream_headers.iter() {
        if HOP_BY_HOP.contains(&name.as_str().to_ascii_lowercase().as_str()) {
            continue;
        }
        out.insert(name.clone(), value.clone());
    }
    if is_new {
        if let Ok(value) = HeaderValue::from_str(&session_cookie(sid)) {
            out.insert(header::SET_COOKIE, value);
        }
    }
    Ok(response)
}

async fn static_handler(State(state): State<Arc<AppState>>, method: Method, uri: Uri) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return (StatusCode::METHOD_NOT_ALLOWED, "Method not allowed").into_response();
    }

    let path = uri.path();
    let key = match path {
        "/" | "/index.html" => "index.html",
        "/about" | "/about/" | "/about.html" => "about.html",
        other => other.trim_start_matches('/'),
    };

    let Some((data, kind)) = state.assets.get(key) else {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    };

    let mut response = if method == Method::HEAD {
        Response::new(Body::empty())
    } else {
        Response::new(Body::from(data.clone()))
    };
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(kind),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache"),
    );
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&data.len().to_string()).unwrap_or(HeaderValue::from_static("0")),
    );
    response
}

fn json_response(status: StatusCode, payload: serde_json::Value) -> Response {
    let body = serde_json::to_vec(&payload).unwrap_or_default();
    let mut response = (status, body).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    response
}

fn session_of(headers: &HeaderMap) -> (String, bool) {
    if let Some(cookie) = headers.get(header::COOKIE).and_then(|value| value.to_str().ok()) {
        for part in cookie.split(';') {
            if let Some((name, value)) = part.split_once('=') {
                if name.trim() == SESSION_COOKIE {
                    let value = value.trim();
                    if value.len() == 36 {
                        return (value.to_string(), false);
                    }
                }
            }
        }
    }
    (uuid_like(), true)
}

fn session_cookie(sid: &str) -> String {
    format!("{SESSION_COOKIE}={sid}; Path=/; HttpOnly; SameSite=Lax")
}

fn host_name(headers: &HeaderMap) -> String {
    let raw = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))
        .and_then(|value| value.to_str().ok())
        .unwrap_or("localhost");
    let host = raw.split(',').next().unwrap_or(raw).trim();
    let host = host.rsplit_once(':').map(|(head, _)| head).unwrap_or(host);
    if host.is_empty() {
        "localhost".to_string()
    } else {
        host.to_string()
    }
}

fn client_ip(headers: &HeaderMap, address: Option<SocketAddr>) -> String {
    if let Some(forwarded) = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return normalize_ip(forwarded);
    }
    address
        .map(|value| normalize_ip(&value.ip().to_string()))
        .unwrap_or_else(|| "unavailable".to_string())
}

fn normalize_ip(value: &str) -> String {
    value.strip_prefix("::ffff:").unwrap_or(value).to_string()
}

/// Session tag only: never a credential, so a counter mixed with the clock is
/// enough and keeps the dependency list at zero for it.
fn uuid_like() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed) as u64;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos() as u64)
        .unwrap_or(0);
    let mut state = nanos ^ (count.wrapping_mul(0x9E37_79B9_7F4A_7C15));
    let mut bytes = [0u8; 16];
    for slot in bytes.iter_mut() {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        *slot = (state >> 32) as u8;
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}
