# Self-built LiteLLM image (CLAUDE.md §7: LiteLLM had compromised releases in 2026).
# Build only from a reviewed, pinned version and verify the package hash.
#   docker build --build-arg LITELLM_VERSION=<x.y.z> --build-arg LITELLM_SHA256=<sha256 of the wheel> -t ghcr.io/krugis/litellm:<x.y.z> infra/litellm
FROM python:3.12-slim
ARG LITELLM_VERSION
ARG LITELLM_SHA256
RUN test -n "$LITELLM_VERSION" && test -n "$LITELLM_SHA256" || (echo "LITELLM_VERSION and LITELLM_SHA256 are required" && exit 1)
RUN pip download --no-deps "litellm[proxy]==${LITELLM_VERSION}" -d /tmp/wheel \
 && echo "${LITELLM_SHA256}  $(ls /tmp/wheel/litellm-*.whl)" | sha256sum -c - \
 && pip install --no-cache-dir "/tmp/wheel/$(ls /tmp/wheel | grep '^litellm-')[proxy]" \
 && rm -rf /tmp/wheel
RUN useradd --system --uid 10001 litellm
USER litellm
COPY config.yaml /app/config.yaml
EXPOSE 4000
CMD ["litellm", "--config", "/app/config.yaml", "--port", "4000"]
