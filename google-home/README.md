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

## v3.22.0 通知キュー
既存の自動起動を使用している場合はリポジトリ直下で次を実行します。依存関係の追加はありません。
```powershell
Stop-ScheduledTask -TaskName "AsobuYasumu-GoogleHome"
git pull --ff-only
Start-ScheduledTask -TaskName "AsobuYasumu-GoogleHome"
Get-Content .\google-home\.local\bridge.log -Tail 30
```
起動ログが `Google Home bridge v3.22.0 notification queue` であることを確認。保護者画面はv3.22.0へ再読み込み。FirestoreルールはGitHub Actionsで公開します。
- 通知の検出と読み上げを分離し、待機最大100件。優先順位は手動、終了・終了忘れ・就寝、予告・休憩終了、開始、報酬の順。再生中は割り込まない。
- 期限：開始30〜45秒、予告45秒、終了・就寝120秒、終了忘れ90秒、休憩終了・報酬180秒、手動120秒。期限・静音時間・設定OFF・利用状況の変更は送信直前と各機器の送信前に再検証する。すでにCastへ渡した音声は中断しない。
- 同じ子ども・同じ通知先で発生時刻差5秒以内の報酬通知を最大4件、160文字までまとめる。集約のため先頭報酬を約2秒待つ。通知種別のON/OFFや個別出力先を尊重。
- 待機中の通知本文はPC内の delivery.json に期限付きで保存。クラッシュ後は期限内の待機のみ復元し、処理中だった通知は重複防止のため再送しない。ログやクラウドのキュー状態に本文は出さない（手動依頼の本文は受領前のみFirestoreの専用コレクションに保存）。
- 手動依頼は別々のドキュメントを作成し、PCが永続化した後に削除。期限切れも削除する。停止中は期限切れまでに受け取れなければ読み上げない。旧UIの単一コマンドは互換処理するが、最新版のUIを使用すること。
- スピーカー未検出・識別不一致のみ1回再試行。再生開始の有無が不確かなエラーやミュートは再試行しない。全件の再生や厳密な時刻を保証するものではない。
- 状態更新は変化時の約5秒間隔と通常のハートビート。旧連携PCではキュー表示・新方式の手動依頼を利用できない。
- 実機確認：PCとスマホで短時間に異なる手動文を各1件依頼し、待機→処理中→履歴を確認。複数スピーカー再生中にゲーム終了時刻を迎えるケース、期限切れ、報酬の集約、停止と再起動、スピーカー未検出を確認。実データの報酬をテストのために作成しない。

## v3.23.0 Linux対応（連携PC側）

Ubuntu Server 24.04 LTS amd64 を対象とします。Windows版の SAPI・PowerShell は従来どおり使えます。Linuxでは Open JTalk を使用し、音声生成はPC内で完結します。通知キュー・Firebaseの専用ユーザー・複数スピーカー設定は変更しません。Web UI・Firestoreルールの更新は不要です。

### Ubuntuでの初回構築

AH56/Dは劣化したバッテリーとメーカーの使用条件を確認し、安全な通電条件が確保できる場合のみ在宅中に検証してください。閉じたままの連続稼働や無人運用を推奨しません。OSのインストール前に必要なデータをバックアップしてください。

管理者の権限を持つ専用の通常ユーザー（例: asobu）で以下を行います。rootでセットアップしないでください。有線LAN、SSH、セキュリティ更新を設定します。

```bash
sudo apt update
sudo apt upgrade
sudo apt install -y software-properties-common
sudo add-apt-repository -y universe
sudo add-apt-repository -y multiverse
sudo apt update
sudo apt install -y git python3 python3-venv util-linux open-jtalk open-jtalk-mecab-naist-jdic hts-voice-nitech-jp-atr503-m001
```

Node.js 22 LTS を公式の https://nodejs.org/en/download から導入してください（Ubuntu標準のnodejsパッケージが22未満の場合は使わない）。公式バイナリを選択する場合は公開SHA256と照合し、PATHに設定します。

```bash
node --version
npm --version
git clone https://github.com/toc99/asobu-yasumu.git
cd asobu-yasumu
bash google-home/setup.sh
```

検証ブランチを使う場合は、setup.sh実行前に git switch linux-google-home-v323 を実行（本番マージ後はmainで可）。setup.shは日本語の固定テスト文のWAV・MP3生成まで検証します。既定の男性音声モデルを使います。別モデルはGH_JTALK_VOICEとGH_JTALK_DICTで指定可能ですが、その場合はテスト実行時にも環境変数を設定して確認してください。

### 移管

1. 旧PCを動かしたままUbuntuの依存関係を準備しても構いませんが、連携プログラムはまだ起動しません。
2. 旧PCで通知キューが空になったことを確認し、手動起動と自動起動タスク（AsobuYasumu-GoogleHome）を停止します。誤って再起動しないよう自動起動を無効化してください。
3. 旧PCの google-home/.env.local と google-home/.local/delivery.json を安全な方法で同じ相対パスに転送します。GH_EMAIL・GH_PASSWORDは既存値、GH_LAN_IPは削除するか新PCのLAN IPへ変更、GH_CAST_HOSTは必要に応じて更新します。Windows専用GH_PYTHONは削除します。秘密をGitHubに登録しないでください。
4. chmod 600 google-home/.env.local google-home/.local/delivery.json （delivery.jsonがある場合）、chmod 700 google-home/.local を実行します。
5. Google Home と同じLANに接続し、UFW等を使用している場合は家庭内LANからTCP 8765とmDNS（UDP 5353）の必要な通信だけを許可。ルーターでポート転送しないでください。

```bash
google-home/.venv/bin/python -X utf8 google-home/list-speakers.py
bash google-home/run.sh
```

保護者画面で接続状態・テスト・任意通知・自動通知・複数機器再生・履歴を確認します。手動起動はCtrl+Cで停止し、子プロセスも停止してから自動起動へ切り替えます。

```bash
bash google-home/install-service.sh
sudo systemctl enable --now asobu-google-home.service
systemctl status asobu-google-home.service
journalctl -u asobu-google-home.service -n 30 --no-pager
```

登録は通常ユーザーで実行し、サービスはそのユーザーで起動します。ログイン不要でOS起動時に開始。異常終了時は30秒間隔で再起動します。flockが同じリポジトリ内の手動・自動の二重起動を防ぎます（別PC・別クローン間の同時起動防止ではありません）。既存のbridge.logローテーションも維持します。

更新は稼働停止後、git pull --ff-only、bash google-home/setup.sh、sudo systemctl start asobu-google-home.service の順。更新失敗時は再起動せず原因確認。切り戻し時は先に sudo systemctl disable --now asobu-google-home.service を実行し、プロセス停止を確認してからWindows版を起動します。可能なら停止後のdelivery.jsonも旧PCへ戻します。停電後の本体自動起動はBIOSに依存します。

実機では日本語の発音・生成速度・Google Home再生・再起動後の自動復帰を確認してください。Ubuntu上で音声のサウンドカードやGUIは不要です。追加月額のTTS API料金はありません。
