# Stage 1: build the single Rust binary used by both roles.
FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

# Stage 2: runtime. Static assets plus one static binary, nothing else.
FROM alpine:3.20
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=build /src/target/release/speedtest /usr/local/bin/speedtest
COPY assets ./assets
ENV PORT=3000 \
    STATIC_DIR=/app/assets
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["speedtest", "probe"]
CMD ["speedtest", "app"]
