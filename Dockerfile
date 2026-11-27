FROM mcr.microsoft.com/playwright:v1.65.1-noble

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    PLAYWRIGHT_VERSION=1.65.1

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    fluxbox \
    novnc \
    websockify \
    x11-utils \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /work

COPY docker/start.sh /usr/local/bin/start-playwright-studio
RUN chmod +x /usr/local/bin/start-playwright-studio

EXPOSE 8080 9323 6080

ENTRYPOINT ["/usr/local/bin/start-playwright-studio"]
