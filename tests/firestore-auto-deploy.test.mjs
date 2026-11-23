import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const workflow = read('../.github/workflows/deploy-firestore-rules.yml');
const setup = read('../scripts/setup-firestore-wif.sh');
const ignore = read('../.gitignore');

test('Firestore rules deployment only follows a tested main branch revision', () => {
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /- 'firestore\.rules'/);
  assert.match(workflow, /needs: verify/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /run: npm run test:rules/);
  assert.match(workflow, /firebase deploy --only firestore:rules --project toc99-41eac --non-interactive/);
  assert.doesNotMatch(workflow, /deploy --only (?:firestore|hosting)(?:\s|$)/);
});

test('keyless Google OIDC authentication is restricted and fail-closed before setup', () => {
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /google-github-actions\/auth@v3/);
  assert.match(workflow, /vars\.FIREBASE_WIF_PROVIDER != ''/);
  assert.match(workflow, /vars\.FIREBASE_WIF_PROVIDER == ''/);
  assert.match(workflow, /service_account: asobu-firestore-rules@toc99-41eac\.iam\.gserviceaccount\.com/);
  assert.doesNotMatch(workflow, /FIREBASE_TOKEN|credentials_json|secrets\./);
  assert.match(ignore, /gha-creds-\*\.json/);
});

test('identity can be assumed only by exact main branch deployment workflow', () => {
  assert.match(setup, /roles\/firebaserules\.admin/);
  assert.match(setup, /roles\/serviceusage\.serviceUsageConsumer/);
  assert.match(setup, /roles\/iam\.workloadIdentityUser/);
  assert.match(setup, /assertion\.repository_id/);
  assert.match(setup, /assertion\.workflow_ref/);
  assert.match(setup, /refs\/heads\/main/);
  assert.match(setup, /assertion\.event_name/);
  assert.doesNotMatch(setup, /service-accounts keys create|--role="roles\/owner"/);
});
