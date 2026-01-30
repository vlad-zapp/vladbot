"""ShowUI-2B Gradio server for UI element grounding."""

import ast
import torch
import gradio as gr
from transformers import Qwen2VLForConditionalGeneration, AutoProcessor
from qwen_vl_utils import process_vision_info
from PIL import Image

SYSTEM_PROMPT = (
    "Based on the screenshot of the page, I give a text description and you "
    "give its corresponding location. The coordinate represents a clickable "
    "location [x, y] for an element, which is a relative coordinate on the "
    "screenshot, scaled from 0 to 1."
)

MIN_PIXELS = 256 * 28 * 28
MAX_PIXELS = 1344 * 28 * 28

print("[ShowUI] Loading model (bf16)...")
model = Qwen2VLForConditionalGeneration.from_pretrained(
    "showlab/ShowUI-2B",
    torch_dtype=torch.bfloat16,
    device_map="auto",
)
processor = AutoProcessor.from_pretrained(
    "showlab/ShowUI-2B",
    min_pixels=MIN_PIXELS,
    max_pixels=MAX_PIXELS,
)
print("[ShowUI] Model loaded.")


def predict(image: Image.Image, query: str) -> str:
    """Run ShowUI grounding and return normalized [x, y] as a string."""
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": SYSTEM_PROMPT},
                {
                    "type": "image",
                    "image": image,
                    "min_pixels": MIN_PIXELS,
                    "max_pixels": MAX_PIXELS,
                },
                {"type": "text", "text": query},
            ],
        }
    ]

    text = processor.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )
    image_inputs, video_inputs = process_vision_info(messages)
    inputs = processor(
        text=[text],
        images=image_inputs,
        videos=video_inputs,
        padding=True,
        return_tensors="pt",
    ).to(model.device)

    with torch.no_grad():
        generated_ids = model.generate(**inputs, max_new_tokens=128)

    generated_ids_trimmed = [
        out_ids[len(in_ids) :]
        for in_ids, out_ids in zip(inputs.input_ids, generated_ids)
    ]
    output_text = processor.batch_decode(
        generated_ids_trimmed, skip_special_tokens=True
    )[0]

    # Parse and validate the output
    try:
        coords = ast.literal_eval(output_text)
        if isinstance(coords, list) and len(coords) == 2:
            return f"{coords[0]}, {coords[1]}"
    except (ValueError, SyntaxError):
        pass

    return output_text


demo = gr.Interface(
    fn=predict,
    inputs=[gr.Image(type="pil"), gr.Textbox(label="Query")],
    outputs=gr.Textbox(label="Coordinates"),
    title="ShowUI-2B",
)

if __name__ == "__main__":
    demo.launch(server_name="0.0.0.0", server_port=7860)
