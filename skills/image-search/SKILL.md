---
name: image-search
description: "两步式图片搜索（预览+选择性下载）。Use when: 需要搜索和下载图片素材。Triggers: 图片搜索, image search, 搜索图片, 下载图片, 素材."
---

# 图片搜索（两步式）

## Step 1 - 搜索预览

```bash
$PYTHON $SCRIPTS/image_search.py search "关键词照片" --limit 20
```

- 只获取预览，不下载
- 输出: `$SEARCH_OUT/image-preview-*.json` 和 `$SEARCH_OUT/image-preview-*.md`

## Step 2 - 选择性下载（AI 判断后执行）

```bash
$PYTHON $SCRIPTS/image_search.py download --from $SEARCH_OUT/image-preview-*.json --indices 1,3,5
```

- 直接下载列表上的图片
- 输出: `$SEARCH_OUT/images-*/`

## 完整流程

1. 搜索: `$PYTHON $SCRIPTS/image_search.py search "迪丽热巴照片"`
2. 查看预览文件，判断哪些图片最符合需求
3. 下载选中的: `$PYTHON $SCRIPTS/image_search.py download --from preview.json --indices 1,2,3`

## 路径变量

- `$PYTHON` = `~/AgentData/.venv/bin/python3`
- `$SCRIPTS` = `~/AgentData/scripts`
- `$SEARCH_OUT` = `~/AgentData/.search-results`
