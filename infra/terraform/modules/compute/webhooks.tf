/**
 * The one path that reaches the API from outside (plan §14.1).
 *
 * Everything a browser does goes through the BFF: the page calls a Next route
 * handler, which calls the API over private DNS. Stripe cannot. A webhook is an
 * inbound request from a third party to `/api/v1/webhooks/stripe`, and it must
 * arrive at the API itself with its raw body and `Stripe-Signature` header
 * untouched — proxying it through the BFF would mean re-serialising the body,
 * and the signature is computed over the exact bytes.
 *
 * So the API gets a target group and one listener rule, scoped to that path
 * prefix and nothing else. The rest of the API stays unreachable from the
 * internet, which is the property the BFF pattern exists to give.
 */

resource "aws_lb_target_group" "api" {
  name        = "${var.name}-api"
  port        = var.api_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    # Liveness, not readiness. A webhook target that fails health checks
    # because the database is briefly unavailable would have Stripe retrying
    # against nothing, and the retry budget is finite.
    path                = "/api/v1/health/live"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  deregistration_delay = 30

  tags = var.tags
}

resource "aws_lb_listener_rule" "stripe_webhooks" {
  listener_arn = aws_lb_listener.https.arn
  # Ahead of the default action, which sends everything else to the BFF.
  priority = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    path_pattern {
      values = ["/api/v1/webhooks/*"]
    }
  }

  # Same proof as every other rule. Stripe reaches this path through
  # CloudFront, so the header is present on a genuine webhook and absent on
  # anything that found the ALB directly.
  condition {
    http_header {
      http_header_name = var.origin_secret_header_name
      values           = [var.origin_secret]
    }
  }

  tags = var.tags
}
