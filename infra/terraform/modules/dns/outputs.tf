output "zone_id" {
  value = data.aws_route53_zone.this.zone_id
}

output "alb_certificate_arn" {
  description = "Regional. The load balancer's listener requires a certificate in its own region."
  value       = aws_acm_certificate_validation.regional.certificate_arn
}

output "cloudfront_certificate_arn" {
  description = "us-east-1, which CloudFront requires regardless of where anything else runs."
  value       = aws_acm_certificate_validation.cloudfront.certificate_arn
}
