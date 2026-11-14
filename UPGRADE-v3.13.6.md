# v3.13.6 — JSONバックアップの権限エラー修正と活動分析データ出力

## 現象
保護者画面の「JSONバックアップ」を押すと `permission-denied`（アクセス権限がありません）と表示される。

## 原因
`app.js` の全件バックアップは `pokemonInventory` コレクションへ制約なしの `getDocs` を実行していた。一方 `firestore.rules` は `pokemonInventory/{childId}` に対し `childId in ['older','younger']` を満たすデータだけ読み取り許可している。
Firestore Rulesはクエリ結果をフィルタしないため、制約なしのコレクション取得は許可されない可能性がある。

## 修正
- 全件バックアップの `pokemonInventory` を、`older` と `younger` の2ドキュメントへ `getDoc` する処理へ変更（`backup-data.js`）。
- 保護者「その他 → 保護者設定」に **活動実績JSON（分析用）** ボタンを追加。
  - `activityRequests` の全件をFirestoreサーバーから取得
  - 子ども識別子（older/younger）、活動キー、状態、日付、申請/処理時刻、申請枠番号のみ含む
  - 名前・生年月日・UID・メールアドレス・ポケモン所持情報・世帯IDなどは含めない
- 失敗時はブラウザの開発者コンソールへエラーを記録し、画面に失敗を表示。
- バージョン、更新履歴、PWAキャッシュを `v3.13.6` に更新。

## セキュリティ
`firestore.rules` の変更は一切不要。既存の閲覧権限を緩めていない。

## テスト
`tests/backup-data.test.mjs` に3件の回帰テストを追加。
実際の `backup-data.js` を使い、模擬Firestoreで以下を確認済み：
1. 許可されたIDだけ読みに行くこと
2. ドキュメント未存在でも適切に除外すること
3. 本物の permission-denied は隠さず失敗扱いとすること

`app.js`、`backup-data.js`、`release-notes.js`、`sw.js` のJavaScript構文確認済み。
Firebase実環境でのバックアップ取得とiPadでの動作確認は未実施。

## 公開後の操作
1. 保護者画面を更新し、アプリバージョンがv3.13.6であることを確認。
2. 「その他」→「保護者設定」→「活動実績JSON（分析用）」を押す。
3. `asobu-yasumu-activity-analysis-YYYY-MM-DD.json` をChatGPTへ添付し、11種類の活動別に利用回数・承認率・子ども別傾向を分析する。
4. 通常の「JSONバックアップ」も押し、エラーなくバックアップファイルが保存されることを確認する。

活動分析ファイルを作成する際はオンライン状態が必要。実績を推測した値で補わず、サーバー上に残る全 `activityRequests` の情報のみを集計する。
