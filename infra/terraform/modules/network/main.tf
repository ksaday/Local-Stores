/**
 * The VPC and its three tiers (plan §14.1).
 *
 * Three subnet tiers across two availability zones, and the separation is a
 * security boundary rather than tidiness: only the load balancer is
 * internet-facing, app tasks reach the internet through NAT and are unreachable
 * from it, and the data tier accepts traffic only from the app tier's security
 * group. A misconfigured service in the app tier therefore cannot be reached
 * from outside even if it binds every interface.
 */

locals {
  # Two AZs is the launch commitment: it survives an AZ loss automatically,
  # which is what §14.6 promises. A third would raise cost and cross-AZ
  # transfer for a failure mode a business at this stage tolerates.
  az_count = 2

  # /20 per tier per AZ — 4,094 usable addresses each. Generous on purpose:
  # Fargate consumes one ENI per task, so a subnet sized for today's task count
  # becomes the scaling ceiling on the day traffic arrives, and resizing a
  # subnet means recreating it.
  public_cidrs   = [for i in range(local.az_count) : cidrsubnet(var.vpc_cidr, 4, i)]
  app_cidrs      = [for i in range(local.az_count) : cidrsubnet(var.vpc_cidr, 4, i + 4)]
  data_cidrs     = [for i in range(local.az_count) : cidrsubnet(var.vpc_cidr, 4, i + 8)]
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(var.tags, { Name = "${var.name}-vpc" })
}

# ── Subnets ──────────────────────────────────────────────────────────────────

resource "aws_subnet" "public" {
  count = local.az_count

  vpc_id            = aws_vpc.this.id
  cidr_block        = local.public_cidrs[count.index]
  availability_zone = data.aws_availability_zones.available.names[count.index]

  # The load balancer lives here and needs a public address. Nothing else does.
  map_public_ip_on_launch = true

  tags = merge(var.tags, {
    Name = "${var.name}-public-${count.index}"
    Tier = "public"
  })
}

resource "aws_subnet" "app" {
  count = local.az_count

  vpc_id            = aws_vpc.this.id
  cidr_block        = local.app_cidrs[count.index]
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = merge(var.tags, {
    Name = "${var.name}-app-${count.index}"
    Tier = "app"
  })
}

resource "aws_subnet" "data" {
  count = local.az_count

  vpc_id            = aws_vpc.this.id
  cidr_block        = local.data_cidrs[count.index]
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = merge(var.tags, {
    Name = "${var.name}-data-${count.index}"
    Tier = "data"
  })
}

# ── Internet and NAT ─────────────────────────────────────────────────────────

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name}-igw" })
}

/**
 * NAT gateways, one per AZ in production and one shared in staging.
 *
 * A single NAT is a single point of failure for all outbound traffic and,
 * worse, sends the other AZ's egress across an AZ boundary — paying twice, in
 * transfer charges and in latency. §14.7 names NAT data transfer as one of the
 * two cost drivers to watch, so staging deliberately takes the cheap option
 * and production does not.
 */
resource "aws_eip" "nat" {
  count  = var.single_nat_gateway ? 1 : local.az_count
  domain = "vpc"
  tags   = merge(var.tags, { Name = "${var.name}-nat-${count.index}" })
}

resource "aws_nat_gateway" "this" {
  count = var.single_nat_gateway ? 1 : local.az_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = merge(var.tags, { Name = "${var.name}-nat-${count.index}" })

  depends_on = [aws_internet_gateway.this]
}

# ── Routing ──────────────────────────────────────────────────────────────────

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name}-public" })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count = local.az_count

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# One table per AZ, so each app subnet egresses through the NAT in its own AZ.
resource "aws_route_table" "app" {
  count = local.az_count

  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name}-app-${count.index}" })
}

resource "aws_route" "app_nat" {
  count = local.az_count

  route_table_id         = aws_route_table.app[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = var.single_nat_gateway ? aws_nat_gateway.this[0].id : aws_nat_gateway.this[count.index].id
}

resource "aws_route_table_association" "app" {
  count = local.az_count

  subnet_id      = aws_subnet.app[count.index].id
  route_table_id = aws_route_table.app[count.index].id
}

/**
 * The data tier has no route to the internet at all.
 *
 * Not "restricted by a security group" — no route. RDS and ElastiCache have no
 * business making outbound connections, and an instance that cannot reach the
 * internet cannot exfiltrate to it whatever else goes wrong.
 */
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name}-data" })
}

resource "aws_route_table_association" "data" {
  count = local.az_count

  subnet_id      = aws_subnet.data[count.index].id
  route_table_id = aws_route_table.data.id
}

/**
 * S3 reaches the VPC through a gateway endpoint rather than the NAT.
 *
 * Media uploads and downloads are the largest S3 traffic this platform moves,
 * and routing them through a NAT gateway means paying per gigabyte for traffic
 * that never needed to leave AWS. The endpoint itself is free. This is the
 * cheapest line in this file and it addresses one of the two cost drivers
 * §14.7 flags.
 */
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"

  route_table_ids = concat(
    aws_route_table.app[*].id,
    [aws_route_table.data.id],
  )

  tags = merge(var.tags, { Name = "${var.name}-s3" })
}
