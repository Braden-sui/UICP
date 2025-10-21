# UICP Claude Code container (default-deny egress with allowlist)
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -y && apt-get install -y --no-install-recommends \
    ca-certificates curl git iptables iproute2 dnsutils jq \
    && rm -rf /var/lib/apt/lists/*

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

# ENTRYPOINT sets firewall then runs provided command (overridden by docker run CMD)
ENTRYPOINT ["/usr/local/bin/with-firewall.sh"]

# Expect the claude CLI to be available (prebaked or bind mounted)
# Default CMD is a help string
CMD ["bash","-lc","claude --help || echo 'Bind mount claude CLI or extend this image to include it.'"]
