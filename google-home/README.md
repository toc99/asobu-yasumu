# あそぶ・やすむ Google Home連携（Windows）

## できること
ゲーム・動画開始、終了予告・お知らせ時刻、終了忘れ確認、休憩開始・終了、就寝準備、チャレンジ承認、経験値、ポケモン獲得・進化、レベルアップ、進化条件、全11チャレンジ達成、新世代解放。保護者画面で種別別ON/OFF、スピーカー名、音量、時間を設定できる。テスト・任意メッセージ、接続状態と最新20件の通知結果を表示する。音声による操作・質問、Switchの停止は行わない。

## 構成と制約
同じ自宅LAN上のWindows PCでNode.jsのFirebaseクライアントが状態を監視し、PowerShellの日本語SAPI音声をWAVに合成し、PC内でMP3に変換してPython/PyChromecastでスピーカーに送る。クラウドに家族名を送って音声合成する必要はない。Google Homeの名称が一致する1台を対象とする。
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
7. 実機確認後、下記の自動起動登録を実施し、再ログオン後に動作確認する。電源接続時に蓋を閉じてもスリープしない設定にする。

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

## 運用と検証（2026-11-24）

### 自動起動・障害復旧
手動起動を停止してから、リポジトリ直下で次を実行する（管理者権限を求められた場合は同じWindowsユーザーで昇格する）。
```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\google-home\install-autostart.ps1 -StartNow
Get-ScheduledTask -TaskName 'AsobuYasumu-GoogleHome'
Get-ScheduledTaskInfo -TaskName 'AsobuYasumu-GoogleHome'
```
現在のユーザーのログオン時に自動起動。異常終了時は1分間隔で最大3回再起動。多重起動は名前付きミューテックスとタスクスケジューラで防止する（旧版プロセスは事前に停止すること）。PCが起動してもサインイン前は動かない。ログオフ・スリープ時は停止する。PC再起動で自動復帰するかは実機で確認する。Git更新やpipインストールは自動では行わない。
停止・登録解除：
```powershell
Stop-ScheduledTask -TaskName 'AsobuYasumu-GoogleHome'
powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\google-home\install-autostart.ps1 -Remove
```
ログは `google-home/.local/bridge.log` に保存し、1MB超で直前1世代を保持。メッセージ本文・認証情報は出力しない。確認：
```powershell
Get-Content .\google-home\.local\bridge.log -Tail 30
```
### IP固定なしの検証
稼働中の連携を止め、同じLAN上で次を実行する。
```powershell
& .\google-home\.venv\Scripts\python.exe -X utf8 .\google-home\list-speakers.py
```
目的の名前が一覧に存在し、同名がないことを確認したら .env.local の GH_CAST_HOST をコメントアウトして再起動・テスト通知。mDNSで名前を検索するためIP変更に追随できる場合がある。失敗時は元の設定に戻す。これはローカルの一覧であり、保護者画面からの選択機能ではない。

### 自動通知の確認
まず静音時間帯外で、実利用中でないときに行う。現在の設定値を控え、変更後は保存、テスト完了後に戻す。家族の実データを削除・初期化したり、Firestoreを直接編集したりしない。
- ゲーム開始、終了予告、終了時刻、終了忘れ：ゲーム通知3分、予告1分、忘れ確認1分に設定、対象4種を有効。iPadで通常のゲーム開始。2分・3分・4分の通知を確認し終了。
- 休憩開始・終了：対象2種を有効にして、通常の終了操作後に休憩開始・終了を確認。夜間持ち越しや手動短縮は通常のアプリ操作の機会に確認する。
- 動画開始・予告・終了時刻：動画利用の設定を一時的に3分、予告1分、対象3種を有効化。休憩終了後の新しい利用サイクルで確認。一時停止中に終了通知しないことも確認する。
- 就寝通知：静音時間外の数分先に一時設定し確認。元に戻す。
- 報酬・経験値・活動・進化等：通常の獲得・承認・レベルアップのタイミングで確認する。検証のために不正な報酬を作成しない。
- 個別OFF、静音時間中の自動通知なし、手動通知の優先再生、PC停止中の古い通知を再生しないことを確認。
- 実行ログの Notification result: <種別> sent / skipped / error と保護者画面の履歴を照合。自動通知は17種別ある。単体テストは `node --test tests/google-home-policy.test.mjs`。

## v3.21.0 複数スピーカー設定
1. 自動起動タスクを停止し、git pull --ff-only で連携PCを更新。依存関係の追加はありません。
2. タスクを再起動（Start-ScheduledTask -TaskName 'AsobuYasumu-GoogleHome'）。ログの冒頭が v3.21.0 multi-speaker であることを確認。
3. 保護者画面をv3.21.0へ更新。Google Home連携の「スピーカーを再検出」を押す。初回・約5分ごとの自動検出も行います。
4. 共通の通知先を最大5台選択し、必要な通知種類に個別の出力先を設定して保存。個別選択なしは共通を使用。共通の選択なしは旧スピーカー名指定を使用。
5. テスト・手動通知の出力先は「テスト・手動通知」の個別設定、未指定なら共通。通知履歴に機器ごとの成功・失敗・スキップを表示します。

UUIDを使用して機器名の変更やIP変更に対応します。以前に発見したIPをPC内にヒントとして保存し、mDNSでも検索します。GH_CAST_HOSTは初回検出の補助として利用できます。ネットワークがmDNSを遮断している場合はIP変更への追随を保証できません。クラウドへ公開する検出情報はUUID・機器名・検出有無のみ。IPアドレスは連携PCのローカル保存のみです。最大12台を表示。グループは重複再生防止のため対象外で、標準Castポート8009の機器を対象とします（TV等も表示される場合があります）。

複数台は順次再生（同時再生・同期なし）。自動通知は各機器の音楽再生・ミュート状態を個別に確認し、手動通知もミュートは解除しません。選択した機器が未検出でも別機器へ代替送信しません。通知発生から3分を超えた残りの機器はスキップ。連携PC停止時の通知を後から再生しない既存仕様を維持。旧連携PCは新しい経路指定を理解できないため、必ず先にPC側を更新してください。自動通知と複数台再生の実機試験は必須です。
