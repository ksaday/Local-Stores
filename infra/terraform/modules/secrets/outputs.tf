output "app_secret_arns" {
  description = "Every application secret, for the execution role's scoped read policy."
  value       = [for s in aws_secretsmanager_secret.app : s.arn]
}

output "jwt_private_key_arn" {
  value = aws_secretsmanager_secret.app["jwt-private-key"].arn
}

output "stripe_secret_key_arn" {
  value = aws_secretsmanager_secret.app["stripe-secret-key"].arn
}

output "stripe_webhook_secret_arn" {
  value = aws_secretsmanager_secret.app["stripe-webhook-secret"].arn
}

output "database_url_arn" {
  value = aws_secretsmanager_secret.database_url.arn
}

output "redis_url_arn" {
  value = aws_secretsmanager_secret.redis_url.arn
}

output "all_secret_arns" {
  description = "Everything the execution role may read, connection strings included."
  value = concat(
    [for s in aws_secretsmanager_secret.app : s.arn],
    [aws_secretsmanager_secret.database_url.arn, aws_secretsmanager_secret.redis_url.arn],
  )
}

output "api_repository_url" {
  value = aws_ecr_repository.this["api"].repository_url
}

output "web_repository_url" {
  value = aws_ecr_repository.this["web"].repository_url
}
