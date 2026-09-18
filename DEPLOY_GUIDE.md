# ototori-kun デプロイ・更新手順書

## 基本情報

| 項目 | 内容 |
|---|---|
| GitHub リポジトリ | https://github.com/Mashi0921/ototori-kun |
| 公開URL | https://Mashi0921.github.io/ototori-kun/ |
| ローカルフォルダ | `/Users/masashinakamura/Research/app-dev/ototori-kun` |

---

## ケース1：ソースコード（App.jsx等）を変更した場合

```bash
cd /Users/masashinakamura/Research/app-dev/ototori-kun
git add src/
git commit -m "変更内容の説明（例: Fix NoteCard stem direction）"
git push origin main
```

プッシュすると GitHub Actions が自動的にビルド＆デプロイします。  
完了まで約2〜3分。進捗確認: https://github.com/Mashi0921/ototori-kun/actions

---

## ケース2：新しい曲を追加する場合

### ステップ1：ファイル名を統一する

新しい曲フォルダ内のファイル名を以下に統一してください：

| 元のファイル名 | 正しいファイル名 |
|---|---|
| `Piano.mp3` / `piano.mp3` | `accompaniment.mp3` |
| `Soprano.mp3` | `soprano.mp3` |
| `Alto.mp3` | `alto.mp3` |

### ステップ2：フォルダ名をASCII（英数字）に変更する

フォルダ名に日本語・スペースが含まれる場合、URLで問題が出るため英数字名に変換します。

```bash
cd /Users/masashinakamura/Research/app-dev/ototori-kun/public/songs

# 例：「新しい曲」→「new_song」フォルダを作成してコピー
mkdir -p new_song
cp "新しい曲/Soprano.mp3" new_song/soprano.mp3
cp "新しい曲/Alto.mp3"    new_song/alto.mp3
cp "新しい曲/Piano.mp3"   new_song/accompaniment.mp3
```

### ステップ3：songs.json に追記する

`/Users/masashinakamura/Research/app-dev/ototori-kun/public/songs/songs.json` を編集：

```json
[
  { "id": "song1",     "title": "COSMOS",                "folder": "song1"     },
  { "id": "hajimari",  "title": "はじまりの予感",        "folder": "hajimari"  },
  { "id": "lalala",    "title": "ラララミュージック",     "folder": "lalala"    },
  { "id": "michi",     "title": "未知という名の船に乗り", "folder": "michi"     },
  { "id": "10sai",     "title": "10歳をむかえる日に",    "folder": "10sai"     },
  { "id": "shabadaba", "title": "Sha ba da ba",           "folder": "shabadaba" },
  { "id": "tomorrow",  "title": "Tomorrow",               "folder": "Tomorrow"  },
  { "id": "new_song",  "title": "新しい曲のタイトル",    "folder": "new_song"  }
]
```

### ステップ4：コミット＆プッシュ

```bash
cd /Users/masashinakamura/Research/app-dev/ototori-kun
git add public/songs/
git commit -m "Add new song: 新しい曲のタイトル"
git push origin main
```

---

## ケース3：音程判定ファイル（JSON）を追加する場合

各曲フォルダに `Soprano.json` と `Alto.json` を追加することでピッチ判定が有効になります。

### ファイル形式

```json
{
  "notes": [
    { "start": 0.0, "end": 0.5, "midi": 67 },
    { "start": 0.5, "end": 1.0, "midi": 69 },
    ...
  ]
}
```

### 配置先

```
public/songs/
  └─ (曲フォルダ名)/
       ├─ soprano.mp3
       ├─ alto.mp3
       ├─ accompaniment.mp3
       ├─ Soprano.json  ← 追加
       └─ Alto.json     ← 追加
```

### プッシュ

```bash
cd /Users/masashinakamura/Research/app-dev/ototori-kun
git add public/songs/(曲フォルダ名)/
git commit -m "Add pitch data for (曲名)"
git push origin main
```

---

## トラブルシューティング

### エラー：`SyntaxError: Unexpected token '<', "<!DOCTYPE "...`

**原因**: `fetch` のパスが間違っている（絶対パスを使っている）  
**確認**: `src/App.jsx` の `fetch` が `${import.meta.env.BASE_URL}songs/...` になっているか確認

```bash
grep -n "fetch(" src/App.jsx
# 正しい例：fetch(`${import.meta.env.BASE_URL}songs/songs.json`)
# NG例：    fetch('/songs/songs.json')
```

### GitHub Actions が失敗する場合

https://github.com/Mashi0921/ototori-kun/actions でエラー内容を確認してください。

### ローカルで動作確認したい場合

```bash
cd /Users/masashinakamura/Research/app-dev/ototori-kun
npm run dev
# → http://localhost:5173/ でアクセス
```

---

## フォルダ構成リファレンス

```
ototori-kun/
├─ src/
│   ├─ App.jsx          メインコンポーネント
│   ├─ main.jsx         エントリーポイント
│   └─ index.css        スタイル
├─ public/
│   └─ songs/
│       ├─ songs.json   ← 曲一覧（必ず更新する）
│       ├─ song1/       COSMOS（既存）
│       ├─ hajimari/    はじまりの予感
│       ├─ lalala/      ラララミュージック
│       ├─ michi/       未知という名の船に乗り
│       ├─ 10sai/       10歳をむかえる日に
│       ├─ shabadaba/   Sha ba da ba
│       └─ Tomorrow/    Tomorrow
├─ .github/
│   └─ workflows/
│       └─ deploy.yml   GitHub Actions 設定（変更不要）
├─ vite.config.js       Vite設定（base: '/ototori-kun/' ）
└─ package.json
```
