# Firestore Security Rules 自動公開（鍵なし認証）

対象: `toc99/asobu-yasumu` / Firebaseプロジェクト `toc99-41eac`

## 運用方式
- `main`の`firestore.rules`またはデプロイ用workflowに変更がある場合、GitHub Actionsの
  **Deploy Firestore Rules (keyless)** が自動起動する。
- `npm test`とFirestore Emulatorテストの**両方**が成功してから、
  `firebase deploy --only firestore:rules`でFirestore Rulesのみ公開。
- 認証はGitHub OIDCとGoogle Cloud Workload Identity Federation（サービスアカウント代理）。
  **JSON秘密鍵やFIREBASE_TOKENは発行・保存しない。**
- 本番データの書き換え・Firebase Hostingデプロイ・Firestore indexes変更は実行しない。
- 本番のルールは`main/firestore.rules`を正本とする。Firebase Consoleの手動変更は次の自動公開時に上書きされる。

## 初回設定（1回だけ・Google Cloudプロジェクトの管理権限が必要）

1. [Google Cloud Shell](https://console.cloud.google.com/cloudshell/editor?project=toc99-41eac) を開く。
2. 以下をCloud Shellに貼り付け、表示内容を確認して実行する。

   ```bash
   git clone https://github.com/toc99/asobu-yasumu.git
   cd asobu-yasumu
   cat scripts/setup-firestore-wif.sh
   bash scripts/setup-firestore-wif.sh
   ```

   既に同名フォルダがある場合は`cd asobu-yasumu && git pull --ff-only`してから実行。
   スクリプトは専用サービスアカウント`asobu-firestore-rules`を作成し、**Firebase Rules Admin**と、Firebase CLIによるAPI状態確認に必要な**Service Usage Consumer**を付与する。サービスの有効化・無効化権限やEditor/Owner権限は付与しない。
   GoogleのWIF OIDCプロバイダは**このリポジトリID、main、専用workflow、push/手動実行**に限定する。

3. スクリプトの最後に表示される`FIREBASE_WIF_PROVIDER`の値をコピー。
4. [GitHubのActions変数設定](https://github.com/toc99/asobu-yasumu/settings/variables/actions)を開き、
   **Variables → New repository variable**で以下を追加する。

   | Name | Value |
   | --- | --- |
   | `FIREBASE_WIF_PROVIDER` | スクリプトの出力（`projects/数字/locations/global/workloadIdentityPools/asobu-github/providers/rules-main`） |

   **Secretsへの登録は不要**。プロバイダのresource名は秘密鍵ではない。

5. [GitHub Actions](https://github.com/toc99/asobu-yasumu/actions/workflows/deploy-firestore-rules.yml)で
   **Run workflow → main → Run workflow**を1度実行し、`verify`と`deploy`が成功することを確認する。
   最初の認証はIAM設定の反映待ちが必要になることがあるので、認証エラーならログを確認する。

## 自動化が有効になる前の挙動
- `FIREBASE_WIF_PROVIDER`が未設定の場合、**デプロイはスキップ**される。
- Actionsの`One-time Google Cloud setup required`ジョブに警告が出る。
  この状態は本番公開成功を意味しない。
- 初回設定後に手動実行で成功すれば、以後は`firestore.rules`のmainへの反映だけで自動公開される。

## 検証するポイント
- 最新の`Deploy Firestore Rules (keyless)`の`verify`と`deploy`がともに緑色
- `deploy`のログにFirestore Rulesの成功が出ている
- Firebase Consoleのルール内容がGitHub mainと一致
- iPadの操作（「いまから休憩の消化を再開」など）が想定どおり動作

## 失敗時
- `verify`失敗: 自動公開は起こらない。テスト失敗を修正。
- `deploy`スキップ: GitHub repository variableが未設定。
- WIF認証失敗: Cloud Shellスクリプトの出力値、Google CloudのIAM権限、
  `repo`/`main`/`workflow_ref`条件、および伝播時間を確認。
- Firebase Rules権限エラー: 専用サービスアカウントへの`roles/firebaserules.admin`付与を確認。
- `firestore.googleapis.com`の状態確認で403エラー: Cloud Shellで`git pull --ff-only && bash scripts/setup-firestore-wif.sh`を再実行し、`roles/serviceusage.serviceUsageConsumer`が付与されていることを確認。
- 既に公開された不正ルールから戻す場合は、正常なコミットの`firestore.rules`をmainへ戻して再公開する。
  重大障害時はFirebase Consoleから直前の正常ルールへロールバックする。
