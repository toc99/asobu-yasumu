# あそぶ・やすむ Google Home連携（Windows）

## できること
ゲーム・動画開始、終了予告・お知らせ時刻、終了忘れ確認、休憩開始・終了、就寝準備、チャレンジ承認、経験値、ポケモン獲得・進化、レベルアップ、進化条件、全11チャレンジ達成、新世代解放。保護者画面で種別別ON/OFF、スピーカー名、音量、時間を設定できる。テスト・任意メッセージ、接続状態と最新20件の通知結果を表示する。音声による操作・質問、Switchの停止は行わない。

## 構成と制約
同じ自宅LAN上のWindows PCでNode.jsのFirebaseクライアントが状態を監視し、PowerShellの日本語SAPI音声をWAVに合成し、Python/PyChromecastでスピーカーに送る。クラウドに家族名を送って音声合成する必要はない。Google Homeの名称が一致する1台を対象とする。
- **Node.js 22 LTS、Python 3.11以降、サポート中のWindows、Japanese desktop SAPI voice** が必要。古いWindows 7等のまま常時接続しない。
- PCとGoogle Homeは同一LAN。ゲストWi-Fi、AP隔離、VPN等で通信を遮断しない。PCは電源接続、スリープ無効で運用する。画面消灯や蓋を閉じるだけなら可。
- 自動通知は他のメディア再生中またはミュート中の場合にスキップ。手動通知は確認後に優先再生するため、既存の再生を停止する場合がある（ミュート中はスキップ）。音量を一時変更し、終了時に元に戻す（突然のPC停止時は復元できない場合あり）。
- 通知はベストエフォートであり、厳密な時刻保証・再生保証はない。通信切断や停止中の古い通知は再送しない。1台の連携PCだけを起動する。
- 休憩時間・ゲームの制御や既存Firestoreデータの更新は行わない。連携機能は通常アプリから独立。
- ゲームのお知らせ時間はGoogle Home独自の目安であり、強制終了ではない。動画の通知は実際の設定・一時停止・動画累計枠を考慮する。
- 読み取りは専用FirebaseユーザーのUIDで許可する。プロフィール（氏名・生年月日等を含む）、設定、報酬・チャレンジ・所持データの参照ができるため、自宅の信頼できるPCのみに認証情報を保存する。家族メンバーとしては登録しない。サービスアカウントJSON鍵・管理者権限は不要。
- Google Homeの接続と日本語音声出力は実機での確認が必須。PyChromecastは非公式のLAN連携ライブラリであり、Google Homeのファームウェア等の変更で動作しなくなる可能性がある。

## 初回設定
1. Firebase Console（toc99-41eac）→ Authentication → Users → Add user。専用メールアドレス・十分長いランダムパスワードのユーザーを追加し、UIDを控える。Firestoreのmembersには追加しない。
2. 保護者画面 → 設定・ポケモン図鑑 → Google Home連携。UID、Google Homeアプリで確認したスピーカー名を入力。有効化をON、通知種類を選び保存する。
3. PCにGit、Node.js 22 LTS、Python 3.11以降をインストール。Windows設定→時刻と言語→音声認識／言語→日本語音声を追加する。System.Speechに日本語のデスクトップ音声があるか確認する（後述）。
4. PowerShellでクローンして、以下を実行（既にクローン済みならリポジトリの中で git pull --ff-only）。

   ```powershell
   git clone https://github.com/toc99/asobu-yasumu.git
   cd asobu-yasumu
   powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\google-home\setup.ps1
   notepad .\google-home\.env.local
   ```

   .env.local の GH_EMAIL と GH_PASSWORD を設定する。パスワードに # 等がある場合は引用符で囲む。絶対にGitHubに追加しない。可能なら管理者以外にアクセスできない専用Windowsユーザーのフォルダを使用する。
5. Windows Defender Firewall（管理者PowerShell）でPCのネットワークをプライベートに設定済みであることを確認し、自宅LANからTCP 8765のみを許可する。

   ```powershell
   New-NetFirewallRule -DisplayName "Asobu Google Home Audio LAN" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8765 -Profile Private -RemoteAddress LocalSubnet
   ```

   PythonのmDNS通信をWindowsが確認した場合はプライベートネットワークのみ許可。ルーターでポート転送はしない。
6. `google-home\start.cmd` を実行する。保護者画面で連携PCの接続表示を確認し、「テスト通知を送る」を押す。スピーカーで日本語が再生され、通知履歴が「送信済み」になることを確認。
7. 実機確認後、Windows タスクスケジューラで、ログオン時起動、失敗時再起動、既に実行中なら新規起動しない設定でstart.cmdを登録する。PC再起動後に動作確認する。電源接続時に蓋を閉じてもスリープしない設定にする。

## 日本語のデスクトップ音声を確認
```powershell
Add-Type -AssemblyName System.Speech
(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo } | Select-Object Name,Culture
```
ja-JP がない場合、Windowsの言語・音声設定を確認する。OneCore専用音声しかない場合はSystem.Speechでは使えないことがある。

## トラブル時
- Firebase権限：保護者画面に入力したUIDが専用AuthユーザーのUIDと一致するか。membersに登録していないか。Firestoreルールが公開済みか。
- スピーカーが見つからない：同一LAN、名前、Wi-Fi隔離、mDNSを確認。必要に応じて .env.local に GH_CAST_HOST（スピーカーIP）を指定。PCに複数NICがある場合は GH_LAN_IP（自宅LAN内のPC IP）も指定。
- 読み上げ失敗：日本語SAPI音声、ファイアウォール、音声出力形式・実機対応を確認。通知履歴のスキップ・失敗理由を確認。ミュート時のスキップは正常仕様。
- PC停止中：アプリ本体はそのまま利用できる。保護者画面で接続状態が古くなる。
- 再送防止は google-home/.local/delivery.json で行う。実行中の編集・削除は避ける。停止・廃棄時は専用Firebaseユーザーを無効化し、保護者画面のUIDを消去して保存する。
- PC常時起動は電気代がかかる。バッテリー劣化、膨張・発熱、冷却、安全性を確認。PCは保守可能なOSに更新する。

### 音声形式の更新（2026-11-24）
既存環境は `git pull --ff-only` 後、`& .\google-home\.venv\Scripts\python.exe -m pip install -r .\google-home\requirements.txt` を実行してから起動。SAPIで生成したWAVはPC内でMP3へ変換し、前後の無音を含め最低5秒の音声を配信します。外部の音声合成サービスは使用しません。
