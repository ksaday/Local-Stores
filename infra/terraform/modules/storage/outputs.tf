output "media_bucket_arn" {
  value = aws_s3_bucket.this.arn
}

output "media_bucket_name" {
  value = aws_s3_bucket.this.id
}

output "media_bucket_regional_domain_name" {
  description = "CloudFront's origin. Regional rather than global, so requests do not take a redirect."
  value       = aws_s3_bucket.this.bucket_regional_domain_name
}
