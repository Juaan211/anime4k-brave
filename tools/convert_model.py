#!/usr/bin/env python3
"""Convert Real-ESRGAN's anime-video-v3 checkpoint to a verified x4 ONNX graph.

Only torch and onnx are needed. The model itself is defined here to avoid
installing realesrgan/BasicSR just for their SRVGGNetCompact class.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkpoint", nargs="?", type=Path, default=Path("models/realesr-animevideov3.pth"))
    parser.add_argument("output", nargs="?", type=Path, default=Path("models/realesr-animevideov3.onnx"))
    args = parser.parse_args()
    if not args.checkpoint.is_file():
        parser.error(f"No existe el checkpoint: {args.checkpoint}")
    try:
        import torch
        from torch import nn
        from torch.nn import functional as F
        import onnx
        from onnx.reference import ReferenceEvaluator
    except ImportError as exc:
        print("Faltan dependencias del entorno virtual. Ejecutá: .\\.venv-tools\\Scripts\\python.exe -m pip install torch onnx", file=sys.stderr)
        raise SystemExit(2) from exc

    class SRVGGNetCompact(nn.Module):
        """BasicSR-compatible SRVGG: 64 features, 16 inner convolutions, x4."""
        def __init__(self, num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=16, upscale=4):
            super().__init__()
            self.upscale = upscale
            self.body = nn.ModuleList([nn.Conv2d(num_in_ch, num_feat, 3, 1, 1), nn.PReLU(num_feat)])
            for _ in range(num_conv):
                self.body.extend((nn.Conv2d(num_feat, num_feat, 3, 1, 1), nn.PReLU(num_feat)))
            self.body.append(nn.Conv2d(num_feat, num_out_ch * upscale * upscale, 3, 1, 1))
            self.upsampler = nn.PixelShuffle(upscale)

        def forward(self, x):
            out = x
            for layer in self.body:
                out = layer(out)
            out = self.upsampler(out)
            return out + F.interpolate(x, scale_factor=self.upscale, mode="nearest")

    torch.manual_seed(7)
    checkpoint = torch.load(args.checkpoint, map_location="cpu", weights_only=True)
    weights = checkpoint.get("params_ema", checkpoint.get("params", checkpoint)) if isinstance(checkpoint, dict) else checkpoint
    model = SRVGGNetCompact().eval()
    model.load_state_dict(weights, strict=True)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_name(args.output.stem + ".verify.tmp.onnx")
    try:
        import numpy as np
        sample = torch.rand(1, 3, 12, 15, dtype=torch.float32)
        with torch.inference_mode():
            torch.onnx.export(
                model, sample, str(temporary), export_params=True, opset_version=17,
                do_constant_folding=True, input_names=["input"], output_names=["output"],
                dynamic_axes={"input": {0: "batch", 2: "height", 3: "width"},
                              "output": {0: "batch", 2: "height_x4", 3: "width_x4"}},
                dynamo=False,
            )

        graph = onnx.load(str(temporary), load_external_data=True)
        onnx.checker.check_model(graph, full_check=True)
        evaluator = ReferenceEvaluator(graph)
        max_error = 0.0
        for height, width in ((12, 15), (9, 11)):
            test_input = torch.rand(1, 3, height, width, dtype=torch.float32)
            with torch.inference_mode():
                expected = model(test_input).cpu().numpy()
            actual = evaluator.run(["output"], {"input": test_input.cpu().numpy()})[0]
            np.testing.assert_allclose(actual, expected, rtol=2e-4, atol=2e-5)
            if actual.shape != (1, 3, height * 4, width * 4):
                raise AssertionError(f"Dimensión ONNX inesperada: {actual.shape}")
            max_error = max(max_error, float(np.max(np.abs(actual - expected))))
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    os.replace(temporary, args.output)
    print(f"ONNX verificado y guardado: {args.output}")
    print(f"Entrada/salida: input {tuple(sample.shape)} → output {tuple((1, 3, sample.shape[2] * 4, sample.shape[3] * 4))}; error máximo absoluto {max_error:.3g}")
    print("Se comprobaron dos tamaños de entrada; el grafo conserva H/W dinámicos y el x4 nativo. El runtime genera x2 reduciendo la salida x4 de cada mosaico.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
