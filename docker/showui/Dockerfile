FROM pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime

ENV HF_HOME=/model-cache

RUN pip install --no-cache-dir \
    "transformers>=4.47.0" \
    "qwen-vl-utils" \
    "accelerate" \
    "gradio" \
    "pillow"

# Pre-download model weights at build time
RUN python -c "\
from transformers import Qwen2VLForConditionalGeneration, AutoProcessor; \
Qwen2VLForConditionalGeneration.from_pretrained('showlab/ShowUI-2B'); \
AutoProcessor.from_pretrained('showlab/ShowUI-2B'); \
print('Model downloaded successfully')"

COPY server.py /app/server.py
WORKDIR /app

EXPOSE 7860

CMD ["python", "server.py"]
