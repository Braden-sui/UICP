# UICP Codex CLI container (default-deny egress with allowlist)
FROM node:20-bookworm-slim

RUN apt-get update -y && apt-get install -y --no-install-recommends \
    ca-certificates git iptables iproute2 dnsutils jq \
    && rm -rf /var/lib/apt/lists/*

# Non-root user for runtime
RUN groupadd -g 10001 app \
    && useradd -u 10001 -g 10001 -m -d /home/app -s /usr/sbin/nologin app \
    && mkdir -p /workspace \
    && chown -R app:app /home/app /workspace
ENV HOME=/home/app

ARG HTTPJAIL_URL=
# Optional: fetch httpjail from a release URL when provided
RUN if [ -n "$HTTPJAIL_URL" ]; then \
      echo "Fetching httpjail from $HTTPJAIL_URL" && \
      curl -fsSL "$HTTPJAIL_URL" -o /usr/local/bin/httpjail && \
      chmod +x /usr/local/bin/httpjail || echo "httpjail fetch failed; continuing"; \
    fi

COPY ../common/with-firewall.sh /usr/local/bin/with-firewall.sh
RUN chmod +x /usr/local/bin/with-firewall.sh

WORKDIR /workspace

USER app
ENTRYPOINT ["/usr/local/bin/with-firewall.sh"]

# Expect codex CLI to be installed (npm i -g @openai/codex-cli?) or bind mounted
CMD ["bash","-lc","codex --help || echo 'Install codex CLI or bind mount it into the container PATH.'"]
