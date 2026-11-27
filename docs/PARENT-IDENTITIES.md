# 保護者アカウント個別化 v3.27.0

## 初回設定（Firebase Console）
1. Authentication の既存保護者の UID を確認。お母さん用に別のメール／パスワードのユーザーを作成し、UID を控える。既存保護者を削除しない。
2. Firestore の `households/{householdId}/members/{お母さんのUID}` に `role` (string) = `parent` を設定。既存保護者の role は維持。
3. `households/{householdId}/settings/parentIdentities` ドキュメントを作成。
   - `fatherUid`: string、既存保護者の UID
   - `motherUid`: string、追加保護者の UID
   - `effectiveFrom`: timestamp、個別利用を開始する時点（過去にさかのぼらない）
4. 双方の端末でそれぞれログイン。親用画面の「ログイン中：」表示を確認。
5. 活動申請をそれぞれ承認、いけんばこに返信、休憩時間を変更し、双方および子ども画面で表示確認。過去の記録は保護者と表示する。

`householdId` は本番の firebase-config.js と既存 Firestore のパスから確認する。メールやパスワードは Firestore に保存しない。ディレクトリは既存ルールでメンバーのみ読め、クライアントから書けない。設定変更は Firebase Console の管理者権限で実施する。UID の再割当ては過去の表示に影響するため行わない。アカウント廃止・再作成時は識別履歴の移行を別途設計する。

既存の活動承認・いけんばこ返信・操作履歴の UID を利用し、既存データ構造・Firestoreルール・Google Home連携PCは変更しない。現行の監査ログ対象外の操作に新たな監査記録は追加しない。
