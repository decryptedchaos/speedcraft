use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::{from_fn, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use bytes::Bytes;
use http_body_util::BodyExt;
use serde::Deserialize;
use serde_json::json;

use crate::config::WorkerRuntimeConfig;

const CHUNK: usize = 256 * 1024;

struct WorkerState {
    id: String,
    location: String,
    max_bytes: u64,
    filler: Bytes,
}

#[derive(Deserialize)]
struct DownQuery {
    bytes: Option<String>,
}

pub async fn run() -> Result<(), String> {
    let cfg = WorkerRuntimeConfig::from_env();
    let id = worker_id();

    let state = Arc::new(WorkerState {
        id: id.clone(),
        location: cfg.location.clone(),
        max_bytes: cfg.max_bytes,
        filler: filler(CHUNK),
    });

    let app = Router::new()
        .route("/health", get(health))
        .route("/healthz", get(health))
        .route("/__speed/ping", get(ping))
        .route("/__speed/meta", get(meta))
        .route("/__speed/down", get(down))
        .route("/__speed/up", post(up))
        .layer(from_fn(cors))
        .with_state(Arc::clone(&state));

    let listener = tokio::net::TcpListener::bind((cfg.bind.as_str(), cfg.port))
        .await
        .map_err(|err| format!("could not bind {}:{}: {err}", cfg.bind, cfg.port))?;
    let port = listener
        .local_addr()
        .map_err(|err| err.to_string())?
        .port();

    // The parent process watches stdout for this exact line when the worker runs
    // as a local child process instead of a container.
    println!("LISTENING {port}");
    println!(
        "worker {} on {}:{} label=\"{}\" maxBytes={}",
        id, cfg.bind, port, cfg.location, cfg.max_bytes
    );

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .map_err(|err| err.to_string())
}

fn worker_id() -> String {
    let host = std::env::var("HOSTNAME").unwrap_or_else(|_| "local".to_string());
    host.chars().take(12).collect()
}

/// One incompressible block reused for every response: no per-chunk allocation
/// on the hot path, and nothing a proxy could shrink.
fn filler(size: usize) -> Bytes {
    let mut state = 0x9E37_79B9_7F4A_7C15u64;
    let mut buffer = vec![0u8; size];
    for byte in buffer.iter_mut() {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        *byte = (state >> 24) as u8;
    }
    Bytes::from(buffer)
}

async fn cors(request: Request, next: Next) -> Response {
    if request.method() == Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        add_cors(response.headers_mut());
        return response;
    }
    let mut response = next.run(request).await;
    add_cors(response.headers_mut());
    response
}

fn add_cors(headers: &mut axum::http::HeaderMap) {
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Content-Type"),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("600"),
    );
}

fn json_response(status: StatusCode, payload: serde_json::Value) -> Response {
    let body = serde_json::to_vec(&payload).unwrap_or_default();
    (
        status,
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json; charset=utf-8"),
            ),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-store"),
            ),
        ],
        body,
    )
        .into_response()
}

async fn health(State(state): State<Arc<WorkerState>>) -> Response {
    json_response(
        StatusCode::OK,
        json!({ "ok": true, "worker": state.id, "maxBytes": state.max_bytes }),
    )
}

async fn ping(State(state): State<Arc<WorkerState>>) -> Response {
    json_response(StatusCode::OK, json!({ "t": now_ms(), "worker": state.id }))
}

async fn meta(State(state): State<Arc<WorkerState>>) -> Response {
    json_response(
        StatusCode::OK,
        json!({
            "label": state.location,
            "worker": state.id,
            "maxBytes": state.max_bytes,
        }),
    )
}

async fn down(State(state): State<Arc<WorkerState>>, Query(query): Query<DownQuery>) -> Response {
    let asked = query
        .bytes
        .as_deref()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(0);
    let total = asked.min(state.max_bytes);
    let filler = state.filler.clone();
    let chunk = filler.len() as u64;

    let stream = futures_util::stream::unfold(0u64, move |sent| {
        let filler = filler.clone();
        async move {
            if sent >= total {
                return None;
            }
            let remaining = total - sent;
            let piece = if remaining >= chunk {
                filler.clone()
            } else {
                filler.slice(0..remaining as usize)
            };
            let next = sent + piece.len() as u64;
            Some((Ok::<Bytes, std::io::Error>(piece), next))
        }
    });

    let mut response = Response::new(Body::from_stream(stream));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(
        header::CONTENT_ENCODING,
        HeaderValue::from_static("identity"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-transform"),
    );
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&total.to_string()).unwrap_or(HeaderValue::from_static("0")),
    );
    response
}

async fn up(request: Request) -> Response {
    let started = Instant::now();
    let mut body = request.into_body();
    let mut received: u64 = 0;
    while let Some(frame) = body.frame().await {
        match frame {
            Ok(frame) => {
                if let Some(data) = frame.data_ref() {
                    received += data.len() as u64;
                }
            }
            Err(_) => break,
        }
    }
    json_response(
        StatusCode::OK,
        json!({
            "ok": true,
            "received": received,
            "serverMs": started.elapsed().as_millis() as u64,
        }),
    )
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0)
}

pub async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut stream) = signal(SignalKind::terminate()) {
            stream.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
