variable "name" { type = string }
variable "region" { type = string }
variable "vpc_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "app_subnet_ids" { type = list(string) }

variable "certificate_arn" {
  description = "ACM certificate for the ALB listener. Must be in this region."
  type        = string
}

variable "api_image" {
  description = "ECR repository URI for the api/worker image. One image, two commands."
  type        = string
}

variable "web_image" {
  type = string
}

variable "image_tag" {
  description = "Immutable tag — a git SHA, never `latest`. A mutable tag makes a rollback ambiguous and a deploy unreproducible."
  type        = string
}

variable "service_discovery_namespace" {
  description = "Private DNS namespace. The BFF resolves api.<namespace> inside the VPC."
  type        = string
  default     = "bba.internal"
}

variable "web_port" {
  type    = number
  default = 3000
}

variable "api_port" {
  type    = number
  default = 3001
}

# §14.4 baselines. Fargate accepts only certain cpu/memory pairs.
variable "web_cpu" {
  type    = number
  default = 1024
}
variable "web_memory" {
  type    = number
  default = 2048
}
variable "web_desired_count" {
  type    = number
  default = 2
}
variable "web_max_count" {
  type    = number
  default = 10
}

variable "api_cpu" {
  type    = number
  default = 1024
}
variable "api_memory" {
  type    = number
  default = 2048
}
variable "api_desired_count" {
  type    = number
  default = 2
}
variable "api_max_count" {
  type    = number
  default = 20
}

variable "worker_cpu" {
  type    = number
  default = 512
}
variable "worker_memory" {
  type    = number
  default = 1024
}
variable "worker_desired_count" {
  type    = number
  default = 1
}
variable "worker_max_count" {
  type    = number
  default = 8
}

variable "log_retention_days" {
  description = "§14.5 wants 90 days hot."
  type        = number
  default     = 90
}

variable "otlp_endpoint" {
  description = "OTLP collector. Empty disables tracing entirely — no SDK, no module patching."
  type        = string
  default     = ""
}

variable "trace_baseline_ratio" {
  description = "Fraction of ordinary traces kept. Errors and slow requests ignore it."
  type        = number
  default     = 0.05
}

variable "database_url_secret_arn" { type = string }
variable "redis_url_secret_arn" { type = string }
variable "jwt_private_key_secret_arn" { type = string }
variable "stripe_secret_key_arn" { type = string }
variable "stripe_webhook_secret_arn" { type = string }

variable "secret_arns" {
  description = "Every secret the execution role may read. Scoped, never secretsmanager:*."
  type        = list(string)
}

variable "media_bucket_arn" {
  description = "S3 bucket for media. The task role reaches only its media/ prefix."
  type        = string
  default     = null
}

variable "origin_secret" {
  description = <<-EOT
    Shared secret CloudFront sends and the load balancer requires. Narrowing
    the security group to CloudFront's ranges is not enough on its own:
    anybody's distribution can be pointed at this ALB and would arrive from the
    same addresses.
  EOT
  type        = string
  sensitive   = true
}

variable "origin_secret_header_name" {
  type    = string
  default = "x-bba-origin"
}

variable "enable_execute_command" {
  description = "ECS Exec — a shell into a running task. Useful in staging, an audited backdoor in production."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  type    = bool
  default = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
