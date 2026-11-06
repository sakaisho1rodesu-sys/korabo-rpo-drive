# korabo-rpo-drive

採用媒体（Green / リクナビHRTech / doda / エンエージェント / CIRCUS）の応募書類を、Driveの連番フォルダへ保存するTampermonkeyスクリプトです。

## インストール
1. Tampermonkeyを入れる
2. 次のURLを開いて「インストール」を押す
   https://raw.githubusercontent.com/sakaisho1rodesu-sys/korabo-rpo-drive/main/saiyo_to_drive.user.js
3. Tampermonkeyのアイコン → このスクリプト → 「GASトークンを設定」「doda対象の社名を設定」を最初に1回だけ行う

更新はTampermonkeyが自動で取得します。

## ファイル
- saiyo_to_drive.user.js … ブラウザ側（自動更新あり）
- 採用媒体_Drive連携.gs … Apps Script側（バックアップ用。IDと社名は伏せてあります。貼り替えは手作業）
