/**
 * The media bucket (plan §14.1, §14.6).
 *
 * Its own module, and the reason is structural rather than tidiness. The task
 * role needs the bucket's ARN, and the CDN distribution needs the bucket's
 * domain name — so if the bucket lived beside the distribution, `compute` would
 * depend on `edge` for the ARN while `edge` depended on `compute` for the load
 * balancer's DNS name. Terraform refuses that graph outright. A bucket depends
 * on nothing, so giving it its own module removes the cycle rather than working
 * around it.
 */

resource "aws_s3_bucket" "this" {
  bucket = var.bucket_name
  tags   = merge(var.tags, { Name = var.bucket_name })
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket = aws_s3_bucket.this.id

  # Every object reaches the world through CloudFront and nothing else. A
  # bucket that is also directly readable makes the CDN's controls — the WAF,
  # the headers, the logs — optional for anyone who knows the bucket name.
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.this.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "media" {
  bucket = aws_s3_bucket.this.id

  # §14.6 recovers media "by version". Without this there is nothing to
  # recover to — a deleted or overwritten object is simply gone.
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "archive-old-versions"
    status = "Enabled"

    filter {}

    # §14.6 sends media to Glacier at a year. Applied to noncurrent versions
    # rather than current ones: the live image a shop displays must stay
    # instantly retrievable however old it is.
    noncurrent_version_transition {
      noncurrent_days = 365
      storage_class   = "GLACIER"
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

/**
 * CORS, scoped to the app's own origin.
 *
 * Uploads are presigned by the API and PUT directly from the browser to S3
 * (§14.1), which is a cross-origin request the bucket has to permit. A
 * wildcard here would let any site on the internet use a leaked presigned URL
 * from a page it controls.
 */
resource "aws_s3_bucket_cors_configuration" "media" {
  bucket = aws_s3_bucket.this.id

  cors_rule {
    allowed_origins = ["https://${var.domain_name}"]
    allowed_methods = ["PUT", "POST", "GET", "HEAD"]
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}
