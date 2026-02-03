# Firestore Data Migration Guide

This document describes the process for copying Firestore data from the `dev-danceup` project (development database) to the `staging-danceup` project (staging database) using gcloud CLI commands.

## Overview

The migration process involves:
1. Exporting all Firestore collections and documents from the source database
2. Importing the exported data into the destination database
3. Verifying the import was successful

**Important**: This process will **overwrite** all existing data in the destination database.

## Prerequisites

### 1. Install and Authenticate gcloud CLI

Ensure you have the Google Cloud SDK installed and authenticated:

```bash
# Check if gcloud is installed
which gcloud

# Authenticate (if not already done)
gcloud auth login
gcloud auth application-default login
```

### 2. Verify Project Access

Verify you have access to both projects:

```bash
# List accessible projects
gcloud projects list --filter="projectId:dev-danceup OR projectId:staging-danceup"

# Verify databases exist
gcloud firestore databases list --project=dev-danceup
gcloud firestore databases list --project=staging-danceup
```

Expected output:
- `dev-danceup` should have a database named `development` (FIRESTORE_NATIVE)
- `staging-danceup` should have a database named `staging` (FIRESTORE_NATIVE)

### 3. Required Permissions

You need the following IAM roles:
- **Source Project (dev-danceup)**: `roles/datastore.owner` or `roles/datastore.user`
- **Destination Project (staging-danceup)**: `roles/datastore.owner` or `roles/datastore.user`
- **Cloud Storage**: `roles/storage.admin` or `roles/storage.objectAdmin` on both projects

## Step-by-Step Migration Process

### Step 1: Create Cloud Storage Buckets

Create temporary buckets in both projects for the export/import process. The buckets must be in the same region as the Firestore databases (us-central1).

```bash
# Create export bucket in dev-danceup
EXPORT_BUCKET="firestore-export-$(date +%Y%m%d-%H%M%S)"
gsutil mb -p dev-danceup -l us-central1 gs://$EXPORT_BUCKET

# Create import bucket in staging-danceup
IMPORT_BUCKET="firestore-import-$(date +%Y%m%d-%H%M%S)"
gsutil mb -p staging-danceup -l us-central1 gs://$IMPORT_BUCKET

# Save bucket names for later use
echo "Export bucket: $EXPORT_BUCKET"
echo "Import bucket: $IMPORT_BUCKET"
```

### Step 2: Export Data from Development Database

Export all collections from the `dev-danceup` project's `development` database:

```bash
gcloud firestore export gs://$EXPORT_BUCKET \
  --project=dev-danceup \
  --database=development
```

**Note**: The export operation is asynchronous and may take several minutes depending on the size of your database. The command will wait for completion and display the export path when finished.

The export will create a timestamped directory in the bucket (e.g., `2025-12-05T02:13:07_56508`). Save this path for the import step.

### Step 3: Copy Export Data to Staging Project Bucket

Since the staging project's service account needs access to the export files, copy them to a bucket in the staging project:

```bash
# Get the export path from Step 2 output
EXPORT_PATH="2025-12-05T02:13:07_56508"  # Replace with actual path

# Copy export data to staging bucket
gsutil -m cp -r gs://$EXPORT_BUCKET/$EXPORT_PATH gs://$IMPORT_BUCKET/
```

### Step 4: Import Data into Staging Database

Import the exported data into the `staging-danceup` project's `staging` database:

```bash
gcloud firestore import gs://$IMPORT_BUCKET/$EXPORT_PATH \
  --project=staging-danceup \
  --database=staging
```

**Note**: The import operation is also asynchronous and may take several minutes. The command will wait for completion.

**Warning**: This will **overwrite** all existing data in the staging database.

### Step 5: Verify Import

Check that the import operation completed successfully:

```bash
# Check import operation status
gcloud firestore operations list \
  --project=staging-danceup \
  --database=staging \
  --format="table(name,metadata.operationState,metadata.progressBytes.processed,metadata.progressDocuments.processed)"
```

Look for an operation with `OPERATION_STATE: SUCCESSFUL`.

You can also verify the data by:
- Checking the Firebase Console for both projects
- Querying sample collections to ensure document counts match
- Testing the staging application to ensure data is accessible

### Step 6: Cleanup (Optional)

After verifying the import, you can delete the temporary buckets to save storage costs:

```bash
# Delete export bucket
gsutil rm -r gs://$EXPORT_BUCKET

# Delete import bucket
gsutil rm -r gs://$IMPORT_BUCKET
```

**Note**: You may want to keep the export bucket for a short period as a backup before deleting.

## Complete Example Script

Here's a complete script that automates the entire process:

```bash
#!/bin/bash

# Configuration
SOURCE_PROJECT="dev-danceup"
SOURCE_DATABASE="development"
DEST_PROJECT="staging-danceup"
DEST_DATABASE="staging"
REGION="us-central1"

# Create buckets
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
EXPORT_BUCKET="firestore-export-$TIMESTAMP"
IMPORT_BUCKET="firestore-import-$TIMESTAMP"

echo "Creating export bucket..."
gsutil mb -p $SOURCE_PROJECT -l $REGION gs://$EXPORT_BUCKET

echo "Creating import bucket..."
gsutil mb -p $DEST_PROJECT -l $REGION gs://$IMPORT_BUCKET

# Export data
echo "Exporting data from $SOURCE_PROJECT ($SOURCE_DATABASE)..."
EXPORT_OUTPUT=$(gcloud firestore export gs://$EXPORT_BUCKET \
  --project=$SOURCE_PROJECT \
  --database=$SOURCE_DATABASE \
  --format="value(metadata.outputUriPrefix)")

# Extract export path from output
EXPORT_PATH=$(basename $EXPORT_OUTPUT)
echo "Export path: $EXPORT_PATH"

# Copy to staging bucket
echo "Copying export data to staging bucket..."
gsutil -m cp -r gs://$EXPORT_BUCKET/$EXPORT_PATH gs://$IMPORT_BUCKET/

# Import data
echo "Importing data into $DEST_PROJECT ($DEST_DATABASE)..."
gcloud firestore import gs://$IMPORT_BUCKET/$EXPORT_PATH \
  --project=$DEST_PROJECT \
  --database=$DEST_DATABASE

echo "Migration completed successfully!"
echo "Export bucket: gs://$EXPORT_BUCKET"
echo "Import bucket: gs://$IMPORT_BUCKET"
echo "Remember to clean up buckets after verification."
```

## Troubleshooting

### Permission Denied Errors

If you encounter permission errors:

1. **Check IAM roles**: Ensure you have the required roles on both projects
2. **Check service account**: The Firestore service account needs access to the Cloud Storage bucket
3. **Bucket permissions**: Ensure the bucket is accessible to the Firestore service account

To grant bucket access to the Firestore service account:

```bash
# Get the Firestore service account email
SERVICE_ACCOUNT=$(gcloud projects describe $DEST_PROJECT --format="value(projectNumber)")@gcp-sa-firestore.iam.gserviceaccount.com

# Grant storage object admin role
gsutil iam ch serviceAccount:$SERVICE_ACCOUNT:roles/storage.objectAdmin gs://$IMPORT_BUCKET
```

### Export/Import Takes Too Long

Large databases can take significant time to export and import:
- **Export**: Typically 1-10 minutes per GB of data
- **Import**: Typically 2-20 minutes per GB of data

Monitor progress using:

```bash
# Check export progress
gcloud firestore operations list --project=$SOURCE_PROJECT --database=$SOURCE_DATABASE

# Check import progress
gcloud firestore operations list --project=$DEST_PROJECT --database=$DEST_DATABASE
```

### Database ID Mismatch

Ensure you're using the correct database IDs:
- Development: `--database=development`
- Staging: `--database=staging`
- Production: `--database=production`

Using `(default)` will target the default database, which may not be the correct one.

### Export Format

Firestore exports use the Entity Export format (not JSON). The export creates:
- `overall_export_metadata`: Metadata about the entire export
- `all_namespaces/all_kinds/export_metadata`: Metadata per collection
- `all_namespaces/all_kinds/output-*`: Actual data files

## Important Notes

1. **Data Overwrite**: The import process will **completely replace** all data in the destination database. Make sure this is what you want.

2. **Database IDs**: Always specify the `--database` flag. The default database `(default)` may not be the one you want to use.

3. **Region Matching**: The Cloud Storage bucket must be in the same region as the Firestore database (us-central1 in this case).

4. **Export Format**: Firestore exports are in Entity Export format, not JSON. You cannot directly read or modify the export files.

5. **Time Considerations**: Large databases may take 30+ minutes to export and import. Plan accordingly.

6. **Cost**: Cloud Storage operations have minimal cost, but large exports/imports may incur charges. Delete temporary buckets after verification.

## Related Documentation

- [Firestore Export/Import Documentation](https://cloud.google.com/firestore/docs/manage-data/export-import)
- [gcloud firestore export](https://cloud.google.com/sdk/gcloud/reference/firestore/export)
- [gcloud firestore import](https://cloud.google.com/sdk/gcloud/reference/firestore/import)
- [Cloud Storage Documentation](https://cloud.google.com/storage/docs)

## Migration History

- **2025-12-04**: Initial migration from dev-danceup (development) to staging-danceup (staging)
  - Export bucket: `gs://firestore-export-20251204-201251`
  - Import bucket: `gs://firestore-import-20251204-201428`
  - Export path: `2025-12-05T02:13:07_56508`
  - Status: ✅ Completed successfully




