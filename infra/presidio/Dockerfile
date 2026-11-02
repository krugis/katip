# SPDX-License-Identifier: AGPL-3.0-only
# Kâtip Presidio analyzer: upstream image + multilingual NER model (LLD-03 §5).
# Structured TR recognizers (TCKN/VKN/IBAN/phone) stay in packages/pii (TypeScript,
# checksum-validated); Presidio contributes PERSON NER for TR + EN.
# Versions and checksum come from katip.config.yaml (images.presidio_analyzer).
ARG PRESIDIO_REGISTRY
ARG PRESIDIO_VERSION
FROM ${PRESIDIO_REGISTRY}:${PRESIDIO_VERSION}
ARG SPACY_MODEL_VERSION
ARG SPACY_MODEL_SHA256
COPY katip-nlp.yaml /app/katip-nlp.yaml
COPY katip-analyzer.yaml /app/katip-analyzer.yaml
COPY katip-recognizers.yaml /app/katip-recognizers.yaml
# xx_ent_wiki_sm: multilingual NER (TR + EN PERSON); no licence constraints (MIT).
# pip verifies the wheel against the sha256 fragment.
RUN test -n "$SPACY_MODEL_VERSION" && test -n "$SPACY_MODEL_SHA256" \
 && pip install --no-cache-dir "https://github.com/explosion/spacy-models/releases/download/xx_ent_wiki_sm-${SPACY_MODEL_VERSION}/xx_ent_wiki_sm-${SPACY_MODEL_VERSION}-py3-none-any.whl#sha256=${SPACY_MODEL_SHA256}"
ENV NLP_CONF_FILE=katip-nlp.yaml
ENV ANALYZER_CONF_FILE=katip-analyzer.yaml
ENV RECOGNIZER_REGISTRY_CONF_FILE=katip-recognizers.yaml
