#!/usr/bin/env python3
"""Whisper 语音转写（无字幕视频自动生成字幕）
用法: python3 whisper_transcribe.py <音频文件> [语言代码] [模型]
输出: stdout 打印 JSON: [{"text","start","end"}, ...]（文本已简体化）
"""
import sys, json, time, os

def main():
    audio_path = sys.argv[1]
    lang = sys.argv[2] if len(sys.argv) > 2 else "auto"
    model_size = sys.argv[3] if len(sys.argv) > 3 else "base"

    from faster_whisper import WhisperModel
    import opencc
    t0 = time.time()
    converter = opencc.OpenCC("t2s")  # 繁体 → 简体
    model = WhisperModel(
        model_size,
        device="cpu",
        compute_type="int8",
        cpu_threads=max(4, min(10, os.cpu_count() or 4)),
    )
    print(f"[whisper] 模型加载完成 ({time.time()-t0:.1f}s)", file=sys.stderr)

    language = None if lang == "auto" else lang
    options = {
        "language": language,
        "vad_filter": True,
        "vad_parameters": {"min_silence_duration_ms": 450},
        "beam_size": 1,
        "condition_on_previous_text": True,
    }
    # 仅中文识别使用中文提示，避免英文视频被中文提示词错误偏置。
    if lang == "zh":
        options["initial_prompt"] = "以下是简体中文语音，保留英文技术名词。"
    segments, info = model.transcribe(audio_path, **options)
    detected_lang = lang if lang != "auto" else (info.language or "zh")
    out = []
    for seg in segments:
        text = (seg.text or "").strip()
        if text and seg.end > seg.start:
            normalized = converter.convert(text) if detected_lang == "zh" else text
            out.append({"text": normalized, "start": round(seg.start, 3), "end": round(seg.end, 3)})
    # 返回真实检测语言（auto 模式由 whisper 自动检测）
    print(json.dumps({"lang": detected_lang, "segments": out}, ensure_ascii=False))
    print(f"[whisper] 转写完成: {len(out)} 条, 语言={detected_lang}, 耗时 {time.time()-t0:.1f}s", file=sys.stderr)

if __name__ == "__main__":
    main()
