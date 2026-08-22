output "distribution_id" {
  description = "For cache invalidation on deploy."
  value       = aws_cloudfront_distribution.app.id
}

output "media_distribution_id" {
  value = aws_cloudfront_distribution.media.id
}

output "media_bucket_arn" {
  description = "The task role is scoped to this bucket's media/ prefix."
  value       = aws_s3_bucket.media.arn
}

output "media_bucket_name" {
  value = aws_s3_bucket.media.id
}

output "app_url" {
  value = "https://${var.domain_name}"
}

output "cdn_url" {
  value = "https://${var.cdn_domain_name}"
}
