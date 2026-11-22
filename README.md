# あそぶ・やすむ

## 開発とデプロイ

- `.github/workflows/verify.yml`: PRと`main`でアプリ・Firestoreルールの回帰テスト
- `.github/workflows/deploy-firestore-rules.yml`: `main`でルール変更後、テストが成功した場合にFirebaseへ自動公開
- [Firestoreルール自動公開の初期設定・運用手順](docs/FIRESTORE-AUTO-DEPLOY.md)

**重要:** Firestoreの自動公開は、初回のGoogle Cloud OIDC設定とGitHub repository variable
`FIREBASE_WIF_PROVIDER`の登録が終わるまでスキップされます。
