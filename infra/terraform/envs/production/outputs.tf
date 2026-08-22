output "app_url" {
  value = module.edge.app_url
}

output "cdn_url" {
  value = module.edge.cdn_url
}

output "cloudfront_distribution_id" {
  description = "For cache invalidation on deploy."
  value       = module.edge.distribution_id
}

output "alb_dns_name" {
  description = "CloudFront's origin. Not a name to hand out — the ALB 403s anything without the secret header."
  value       = module.compute.alb_dns_name
}

output "postgres_endpoint" {
  description = "For assembling the database URL secret. Private — resolvable only inside the VPC."
  value       = module.data.postgres_endpoint
}

output "postgres_master_secret_arn" {
  description = "The AWS-managed master password, for the same purpose."
  value       = module.data.postgres_secret_arn
}

output "redis_endpoint" {
  value = module.data.redis_endpoint
}

output "api_repository_url" {
  value = module.secrets.api_repository_url
}

output "web_repository_url" {
  value = module.secrets.web_repository_url
}
