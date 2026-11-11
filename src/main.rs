mod app;
mod config;
mod docker;
mod pool;
mod worker;

use std::time::Duration;

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .pool_max_idle_per_host(64)
        .tcp_nodelay(true)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("http client")
}

/// Container healthcheck for both roles. The app serves on PORT while the same
/// image also carries WORKER_PORT for the workers it spawns, so a single guess
/// can point at the wrong port; accept a connection on any port this process is
/// configured to listen on.
fn probe() -> i32 {
    let mut ports: Vec<u16> = Vec::new();
    for key in ["PORT", "WORKER_PORT"] {
        if let Some(port) = std::env::var(key)
            .ok()
            .and_then(|value| value.trim().parse::<u16>().ok())
        {
            if !ports.contains(&port) {
                ports.push(port);
            }
        }
    }
    if ports.is_empty() {
        ports.push(3000);
    }

    for port in &ports {
        let address: std::net::SocketAddr = match format!("127.0.0.1:{port}").parse() {
            Ok(address) => address,
            Err(_) => continue,
        };
        if std::net::TcpStream::connect_timeout(&address, Duration::from_secs(3)).is_ok() {
            return 0;
        }
    }

    eprintln!("[speedtest] probe could not connect on ports {ports:?}");
    1
}

#[tokio::main]
async fn main() {
    let role = std::env::args().nth(1).unwrap_or_else(|| "app".to_string());

    if role == "probe" {
        std::process::exit(probe());
    }

    let result = if role == "worker" {
        worker::run().await
    } else {
        app::run().await
    };

    if let Err(err) = result {
        eprintln!("[speedtest] {err}");
        std::process::exit(1);
    }
}
