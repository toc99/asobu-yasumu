#!/usr/bin/env bash
# One-time, keyless GitHub Actions -> Firebase Rules deployment setup.
# Run in Google Cloud Shell as a project Owner / IAM administrator.
set -euo pipefail

PROJECT_ID="toc99-41eac"
REPO="toc99/asobu-yasumu"
REPO_ID="1444215426"
POOL_ID="asobu-github"
PROVIDER_ID="rules-main"
SERVICE_ACCOUNT_ID="asobu-firestore-rules"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_ID}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "Configuring keyless Firestore rules deploy for ${REPO} -> ${PROJECT_ID}"
gcloud config set project "${PROJECT_ID}" >/dev/null

echo "Enabling required Google Cloud APIs..."
gcloud services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com firebaserules.googleapis.com \
  --project="${PROJECT_ID}" --quiet >/dev/null

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
if [[ -z "${PROJECT_NUMBER}" ]]; then
  echo "Could not read Google Cloud project number." >&2
  exit 1
fi

echo "Creating dedicated service account (if missing)..."
if ! gcloud iam service-accounts describe "${SERVICE_ACCOUNT_EMAIL}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SERVICE_ACCOUNT_ID}" \
    --project="${PROJECT_ID}" \
    --display-name="Asobu Firestore Rules CI deployer" --quiet >/dev/null
fi

# No Firestore documents access, project Editor, Owner, or service-account private keys.
echo "Granting Firebase Rules Admin (not project Owner/Editor)..."
# A newly created service account can take time to propagate to Cloud Resource Manager.
# Retry transient IAM replication errors instead of leaving a half-configured project.
for attempt in 1 2 3 4 5; do
  if gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role="roles/firebaserules.admin" --condition=None --quiet >/dev/null; then
    break
  fi
  if [[ "${attempt}" == 5 ]]; then
    echo "Could not grant Firebase Rules Admin after retries." >&2
    echo "Check that the service account exists and your account has Project IAM Admin." >&2
    exit 1
  fi
  echo "IAM update not ready yet (attempt ${attempt}/5); retrying..." >&2
  sleep "$((attempt * 10))"
done

# Firebase CLI inspects Google API enablement via Service Usage before it deploys
# Firestore rules. This role provides services.get/list/use, without permission
# to enable/disable APIs or administer unrelated Firebase services.
echo "Granting Service Usage Consumer for Firebase CLI API checks..."
for attempt in 1 2 3 4 5; do
  if gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role="roles/serviceusage.serviceUsageConsumer" --condition=None --quiet >/dev/null; then
    break
  fi
  if [[ "${attempt}" == 5 ]]; then
    echo "Could not grant Service Usage Consumer after retries." >&2
    echo "Check IAM administration permission for this Google Cloud project." >&2
    exit 1
  fi
  echo "Service Usage IAM update not ready (attempt ${attempt}/5); retrying..." >&2
  sleep "$((attempt * 10))"
done

echo "Creating GitHub Workload Identity Pool (if missing)..."
if ! gcloud iam workload-identity-pools describe "${POOL_ID}" \
    --project="${PROJECT_ID}" --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "${POOL_ID}" \
    --project="${PROJECT_ID}" --location=global \
    --display-name="Asobu GitHub Actions" --quiet >/dev/null
fi

# Only the exact GitHub repository ID, main branch, deploy workflow, and
# push/manual-dispatch events are trusted. This prevents other workflows and PRs.
ATTRIBUTE_CONDITION="assertion.repository == '${REPO}' && assertion.repository_id == '${REPO_ID}' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref == '${REPO}/.github/workflows/deploy-firestore-rules.yml@refs/heads/main' && (assertion.event_name == 'push' || assertion.event_name == 'workflow_dispatch')"

echo "Creating tightly restricted OIDC provider (if missing)..."
if gcloud iam workload-identity-pools providers describe "${PROVIDER_ID}" \
    --project="${PROJECT_ID}" --location=global \
    --workload-identity-pool="${POOL_ID}" >/dev/null 2>&1; then
  CURRENT_CONDITION="$(gcloud iam workload-identity-pools providers describe "${PROVIDER_ID}" \
    --project="${PROJECT_ID}" --location=global \
    --workload-identity-pool="${POOL_ID}" --format='value(attributeCondition)')"
  if [[ "${CURRENT_CONDITION}" != "${ATTRIBUTE_CONDITION}" ]]; then
    echo "Provider already exists with a DIFFERENT attribute condition. Refusing to reuse it." >&2
    echo "Please inspect the provider in Google Cloud IAM before continuing." >&2
    exit 1
  fi
else
  gcloud iam workload-identity-pools providers create-oidc "${PROVIDER_ID}" \
    --project="${PROJECT_ID}" --location=global \
    --workload-identity-pool="${POOL_ID}" \
    --display-name="Asobu main Firestore Rules" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition="${ATTRIBUTE_CONDITION}" \
    --quiet >/dev/null
fi

echo "Allowing only this repository identity to impersonate the dedicated service account..."
gcloud iam service-accounts add-iam-policy-binding "${SERVICE_ACCOUNT_EMAIL}" \
  --project="${PROJECT_ID}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${REPO}" \
  --quiet >/dev/null

echo
echo "Google Cloud setup finished."
echo "Open: https://github.com/${REPO}/settings/variables/actions"
echo "Create a Repository variable with this exact name and value:"
echo
echo "Name:  FIREBASE_WIF_PROVIDER"
echo "Value: projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"
echo
echo "Then run 'Deploy Firestore Rules (keyless)' once from the GitHub Actions tab (main branch)."
echo "No JSON service-account key, Firebase token, or GitHub secret is needed."
