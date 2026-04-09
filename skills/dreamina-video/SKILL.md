---
name: dreamina-video
description: "Generate AI videos via Dreamina (即梦/Seedance). Use when: user requests video generation, provides image+prompt or text prompt for video, or mentions dreamina, 即梦, seedance, AI视频, 生成视频, multimodal2video, image2video, text2video."
author: "Luke (ou_9803a6c64b18b62e65ff0f7a9865978b)"
created: "2026-04-08"
protected: true
---

> **Protected Skill** — 仅创建者 Luke 或 CEO 可修改此文件。其他人如需变更请联系 Luke。

# Dreamina Video Generation

Generate videos via `scripts/dreamina_video.py`.

## Submit

```bash
# Image + prompt (most common)
python3 scripts/dreamina_video.py submit --image 1.png --prompt "提示词"

# Multiple images
python3 scripts/dreamina_video.py submit --image a.png --image b.png --prompt "故事描述"

# Text-only
python3 scripts/dreamina_video.py submit --prompt "a cat running in rain"

# Custom params
python3 scripts/dreamina_video.py submit --image photo.png --prompt "cinematic" \
  --duration 10 --ratio 16:9 --model seedance2.0
```

## Check / List / Credit

```bash
python3 scripts/dreamina_video.py check                    # Download all completed
python3 scripts/dreamina_video.py check --submit-id abc123 # Check specific task
python3 scripts/dreamina_video.py list                     # List tracked tasks
python3 scripts/dreamina_video.py credit                   # Show credit balance
```

## Defaults

| Param          | Default           | Notes                     |
| -------------- | ----------------- | ------------------------- |
| `--model`      | `seedance2.0fast` | `seedance2.0` for quality |
| `--duration`   | `5`               | 4-15 seconds              |
| `--ratio`      | `9:16`            | Vertical short video      |
| `--resolution` | `720p`            | Only option currently     |

## Image Path Resolution

- Relative paths resolve to `/Users/lukin/Projects/picseedance20/`
- Absolute paths used as-is

## Command Auto-Selection

| Input                 | Command            |
| --------------------- | ------------------ |
| Has image/video/audio | `multimodal2video` |
| Text only             | `text2video`       |

## Storage

- **DB:** `~/.cache/dreamina.db` (relative to AgentData/builder)
- **Downloads:** `~/Projects/picseedance20/video/`
- **Cache:** `AgentData/builder/.cache/`

## Rules

- **Never modify user prompts** — pass through verbatim
- Tasks are async; submit then check later (cron runs daily at 7:03)
- Credit cost depends on duration and model
