/**
 * Autoscaling, from §14.4's table.
 *
 * Target tracking rather than step scaling: it holds a metric at a value and
 * works out the task count itself, which is the right shape when the target is
 * "CPU around 60%" rather than "add two tasks when X".
 */

locals {
  scalable = {
    web = {
      min = var.web_desired_count
      max = var.web_max_count
    }
    api = {
      min = var.api_desired_count
      max = var.api_max_count
    }
    worker = {
      min = var.worker_desired_count
      max = var.worker_max_count
    }
  }

  service_names = {
    web    = aws_ecs_service.web.name
    api    = aws_ecs_service.api.name
    worker = aws_ecs_service.worker.name
  }
}

resource "aws_appautoscaling_target" "this" {
  for_each = local.scalable

  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${local.service_names[each.key]}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = each.value.min
  max_capacity       = each.value.max
}

# CPU at 60%, per §14.4. Applies to all three: it is the trigger the table
# names for web and api, and a reasonable floor for the worker even though the
# condition that actually matters there is queue depth.
resource "aws_appautoscaling_policy" "cpu" {
  for_each = local.scalable

  name               = "${var.name}-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this[each.key].service_namespace
  resource_id        = aws_appautoscaling_target.this[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.this[each.key].scalable_dimension

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }

    target_value = 60

    # Out fast, in slow. Scaling in during a lull that turns out to be a pause
    # between bursts costs a cold start on the next request; the asymmetry is
    # deliberate.
    scale_out_cooldown = 60
    scale_in_cooldown  = 300
  }
}

/**
 * Requests per target, for the web tier only.
 *
 * §14.4 puts the threshold at 800 req/target. This is the trigger that catches
 * a traffic spike that has not yet become a CPU problem, which for a Next.js
 * server rendering pages is most of them — it blocks on the API before it
 * saturates a core.
 */
resource "aws_appautoscaling_policy" "web_requests" {
  name               = "${var.name}-web-requests"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this["web"].service_namespace
  resource_id        = aws_appautoscaling_target.this["web"].resource_id
  scalable_dimension = aws_appautoscaling_target.this["web"].scalable_dimension

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.this.arn_suffix}/${aws_lb_target_group.web.arn_suffix}"
    }

    target_value       = 800
    scale_out_cooldown = 60
    scale_in_cooldown  = 300
  }
}

/**
 * NOT IMPLEMENTED, deliberately: the worker's real trigger.
 *
 * §14.4 scales the worker on "queue depth > 500 or oldest job > 60s", and
 * neither is an ECS-native metric. Both are already published by the platform
 * itself — `queue_depth{queue,state}` in docs/ops/observability.md §2 — but
 * scaling on them needs that metric in CloudWatch, which needs the metrics
 * pipeline landing there rather than in a Prometheus-compatible store.
 *
 * The CPU policy above is a floor, not a substitute. A worker blocked on a
 * slow SES call has a deep queue and idle CPU, which is precisely the case
 * §14.4 wants to scale and CPU cannot see. Wiring this up is a prerequisite
 * for the worker tier meeting its stated behaviour.
 */
