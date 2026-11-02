# SPDX-License-Identifier: AGPL-3.0-only
# Kâtip Presidio analyzer: upstream image + multilingual NER model (LLD-03 §5).
# Structured TR recognizers (TCKN/VKN/IBAN/phone) stay in packages/pii (TypeScript,
# checksum-validated); Presidio contributes PERSON NER for TR + EN.
ARG PRESIDIO_VERSION=2.2.366
FROM ghcr.io/data-privacy-stack/presidio-analyzer:${PRESIDIO_VERSION}
COPY katip-nlp.yaml /app/katip-nlp.yaml
COPY katip-analyzer.yaml /app/katip-analyzer.yaml
COPY katip-recognizers.yaml /app/katip-recognizers.yaml
# xx_ent_wiki_sm: multilingual NER (TR + EN PERSON); no licence constraints (MIT).
RUN python -m spacy download xx_ent_wiki_sm
ENV NLP_CONF_FILE=katip-nlp.yaml
ENV ANALYZER_CONF_FILE=katip-analyzer.yaml
ENV RECOGNIZER_REGISTRY_CONF_FILE=katip-recognizers.yaml
