variable "name" {
  description = "Name prefix for every resource in this module."
  type        = string
}

variable "region" {
  description = "AWS region. Needed for the S3 gateway endpoint's service name."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR for the VPC. Must be at least a /16 to fit three /20 tiers across two AZs."
  type        = string
  default     = "10.0.0.0/16"

  validation {
    condition     = tonumber(split("/", var.vpc_cidr)[1]) <= 16
    error_message = "The VPC needs a /16 or larger: six /20 subnets are carved from it, and Fargate consumes one address per task."
  }
}

variable "single_nat_gateway" {
  description = <<-EOT
    Share one NAT gateway across both AZs. Saves roughly $35/month and makes
    all outbound traffic depend on one AZ — acceptable in staging, not in
    production.
  EOT
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}
