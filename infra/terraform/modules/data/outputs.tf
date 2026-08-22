output "postgres_endpoint" {
  value = aws_db_instance.this.address
}

output "postgres_port" {
  value = aws_db_instance.this.port
}

output "postgres_secret_arn" {
  description = <<-EOT
    The AWS-managed master password. Tasks read this at start rather than
    receiving a password through Terraform state, which is plaintext JSON
    however carefully the bucket is locked down.
  EOT
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "redis_endpoint" {
  value = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "redis_port" {
  value = aws_elasticache_replication_group.this.port
}
