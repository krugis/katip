# SPDX-License-Identifier: AGPL-3.0-only
# Kâtip Presidio analyzer: upstream image + a Turkish name model (LLD-03 §5).
# Structured TR recognizers (TCKN/VKN/IBAN/phone) stay in packages/pii (TypeScript,
# checksum-validated); Presidio contributes PERSON NER for TR + EN.
# Versions and checksum come from katip.config.yaml (images.presidio_analyzer).
ARG PRESIDIO_REGISTRY
ARG PRESIDIO_VERSION
FROM ${PRESIDIO_REGISTRY}:${PRESIDIO_VERSION}
ARG SPACY_MODEL_VERSION
ARG SPACY_MODEL_SHA256
ARG NER_MODEL
ARG NER_MODEL_REVISION
COPY requirements.txt /app/requirements.txt
# xx_ent_wiki_sm only splits text into tokens now (MIT).
# pip verifies the wheel against the sha256 fragment.
RUN test -n "$SPACY_MODEL_VERSION" && test -n "$SPACY_MODEL_SHA256" \
 && pip install --no-cache-dir "https://github.com/explosion/spacy-models/releases/download/xx_ent_wiki_sm-${SPACY_MODEL_VERSION}/xx_ent_wiki_sm-${SPACY_MODEL_VERSION}-py3-none-any.whl#sha256=${SPACY_MODEL_SHA256}"
# The name model, fixed to one commit of its repository (MIT, see the model card). 'first'
# in katip-nlp.yaml is how the card says to group its output. Baked in: no internet at run.
RUN test -n "$NER_MODEL" && test -n "$NER_MODEL_REVISION" \
 && pip install --no-cache-dir -r /app/requirements.txt \
 && python -c "import sys; from huggingface_hub import snapshot_download; snapshot_download(repo_id=sys.argv[1], revision=sys.argv[2], local_dir='/app/ner-model', allow_patterns=['config.json', 'model.safetensors', 'tokenizer.json', 'tokenizer_config.json', 'vocab.txt', 'special_tokens_map.json'])" "$NER_MODEL" "$NER_MODEL_REVISION"
COPY katip-nlp.yaml /app/katip-nlp.yaml
COPY katip-analyzer.yaml /app/katip-analyzer.yaml
COPY katip-recognizers.yaml /app/katip-recognizers.yaml
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1
ENV NLP_CONF_FILE=katip-nlp.yaml
ENV ANALYZER_CONF_FILE=katip-analyzer.yaml
ENV RECOGNIZER_REGISTRY_CONF_FILE=katip-recognizers.yaml
