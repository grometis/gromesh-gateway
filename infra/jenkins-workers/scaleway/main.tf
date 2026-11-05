locals {
  proposed_nodes = {
    pr-amd64    = { type = "BASIC3-X8C-32G", arch = "amd64", overlay = "10.89.0.11", data = true }
    pr-arm64    = { type = "BASIC2-A8C-32G", arch = "arm64", overlay = "10.89.0.12", data = true }
    coordinator = { type = "DEV1-S", arch = "amd64", overlay = "10.89.0.1", data = true }
  }
  nodes         = var.provisioning_approved ? local.proposed_nodes : {}
  tags          = ["project:gromesh-gateway", "managed-by:gromesh-j8", "generation:${var.generation}"]
  denied_ranges = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10"]
}
resource "scaleway_instance_ip" "node" {
  for_each   = local.nodes
  project_id = var.project_id
  zone       = var.zone
  tags       = concat(local.tags, ["role:${each.key}"])
  lifecycle { prevent_destroy = true }
}
resource "scaleway_block_volume" "work" {
  for_each   = { for key, node in local.nodes : key => node if node.data }
  name       = "${var.generation}-${each.key}-work"
  project_id = var.project_id
  zone       = var.zone
  size_in_gb = each.key == "coordinator" ? 35 : 216
  iops       = 5000
  tags       = concat(local.tags, ["role:${each.key}"])
  lifecycle { prevent_destroy = true }
}
resource "scaleway_instance_security_group" "node" {
  for_each                = local.nodes
  name                    = "${var.generation}-${each.key}"
  project_id              = var.project_id
  zone                    = var.zone
  inbound_default_policy  = "drop"
  outbound_default_policy = "drop"
  stateful                = true
  tags                    = concat(local.tags, ["role:${each.key}"])
  dynamic "inbound_rule" {
    for_each = each.key == "coordinator" ? concat([var.operator_cidr], [for k, ip in scaleway_instance_ip.node : "${ip.address}/32" if k != "coordinator"]) : []
    content {
      action   = "accept"
      protocol = "UDP"
      port     = 51820
      ip_range = inbound_rule.value
    }
  }
  outbound_rule {
    action   = "accept"
    protocol = "TCP"
    port     = 80
    ip_range = "169.254.42.42/32"
  }
  dynamic "outbound_rule" {
    for_each = local.denied_ranges
    content {
      action   = "drop"
      protocol = "ANY"
      ip_range = outbound_rule.value
    }
  }
  outbound_rule {
    action   = "accept"
    protocol = "TCP"
    port     = 443
    ip_range = "0.0.0.0/0"
  }
  dynamic "outbound_rule" {
    for_each = ["1.1.1.1/32", "9.9.9.9/32"]
    content {
      action   = "accept"
      protocol = "UDP"
      port     = 53
      ip_range = outbound_rule.value
    }
  }
  outbound_rule {
    action   = "accept"
    protocol = "UDP"
    port     = 123
    ip_range = "0.0.0.0/0"
  }
  dynamic "outbound_rule" {
    for_each = each.key == "coordinator" ? concat([var.operator_cidr], [for k, ip in scaleway_instance_ip.node : "${ip.address}/32" if k != "coordinator"]) : ["${scaleway_instance_ip.node["coordinator"].address}/32"]
    content {
      action   = "accept"
      protocol = "UDP"
      port     = 51820
      ip_range = outbound_rule.value
    }
  }
  lifecycle { prevent_destroy = true }
}
resource "scaleway_instance_server" "node" {
  for_each          = local.nodes
  name              = "${var.generation}-${each.key}"
  type              = each.value.type
  image             = var.image_ids[each.value.arch]
  project_id        = var.project_id
  zone              = var.zone
  ip_id             = scaleway_instance_ip.node[each.key].id
  security_group_id = scaleway_instance_security_group.node[each.key].id
  state             = var.worker_state
  protected         = var.server_protection_enabled
  tags              = concat(local.tags, ["role:${each.key}", "trust:${each.key == "coordinator" ? "protected" : "untrusted"}"])
  root_volume {
    size_in_gb            = 35
    volume_type           = "sbs_volume"
    sbs_iops              = 5000
    delete_on_termination = false
    name                  = "${var.generation}-${each.key}-boot"
  }
  additional_volume_ids = each.value.data ? [scaleway_block_volume.work[each.key].id] : []
  user_data = {
    cloud-init = "#cloud-config\n${yamlencode({
      hostname = "${var.generation}-${each.key}", preserve_hostname = false, disable_root = true, ssh_pwauth = false, package_update = true,
      apt      = { primary = [{ arches = ["amd64"], uri = "https://archive.ubuntu.com/ubuntu" }, { arches = ["arm64"], uri = "https://ports.ubuntu.com/ubuntu-ports" }], security = [{ arches = ["amd64"], uri = "https://security.ubuntu.com/ubuntu" }, { arches = ["arm64"], uri = "https://ports.ubuntu.com/ubuntu-ports" }] },
      packages = ["openssh-server", "openjdk-21-jre-headless", "python3", "python3-venv", "curl", "ca-certificates", "gnupg", "jq", "uidmap", "dbus-user-session", "slirp4netns", "rootlesskit", "fuse-overlayfs", "xfsprogs", "nftables", "wireguard-tools", "git", "make", "build-essential", "unzip", "xz-utils", "socat", "rsync"],
      users    = [{ name = "gromesh-admin", shell = "/bin/bash", groups = ["sudo"], sudo = ["ALL=(ALL) NOPASSWD:ALL"], lock_passwd = true, ssh_authorized_keys = [var.admin_ssh_public_key] }],
      write_files = concat([
        { path = "/etc/gromesh-j8/context.json", owner = "root:root", permissions = "0600", content = jsonencode({ schema = "gromesh-cloud-context/v1", generation = var.generation, hostname = "${var.generation}-${each.key}", role = each.key, architecture = each.value.arch, projectId = var.project_id, overlayIp = each.value.overlay, relayPublicIp = scaleway_instance_ip.node["coordinator"].address, operatorCidr = var.operator_cidr, workerPublicIps = [for k, v in scaleway_instance_ip.node : v.address if k != "coordinator"], volumeId = each.value.data ? scaleway_block_volume.work[each.key].id : null }) },
        { path = "/etc/ssh/sshd_config.d/00-gromesh.conf", owner = "root:root", permissions = "0644", content = "PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAllowUsers gromesh-admin\nDisableForwarding yes\nPermitTunnel no\n" },
        { path = "/etc/systemd/system/user-1100.slice.d/limits.conf", owner = "root:root", permissions = "0644", content = "[Slice]\nCPUQuota=${each.key == "coordinator" ? 200 : 800}%\nMemoryMax=${each.key == "coordinator" ? "1G" : "24G"}\nMemorySwapMax=0\nTasksMax=4096\n" },
        { path = "/etc/systemd/journald.conf.d/gromesh.conf", owner = "root:root", permissions = "0644", content = "[Journal]\nSystemMaxUse=128M\nRuntimeMaxUse=64M\nSystemKeepFree=2G\nRateLimitIntervalSec=30s\nRateLimitBurst=1000\n" },
        { path = "/etc/systemd/resolved.conf.d/gromesh.conf", owner = "root:root", permissions = "0644", content = "[Resolve]\nDNS=1.1.1.1 9.9.9.9\nFallbackDNS=\n" }
        ], [for script in ["prepare.sh", "bootstrap.py", "enroll.py", "activate-runtime.sh"] : { path = "/usr/local/lib/gromesh-j8/${script}", owner = "root:root", permissions = "0700", content = file("${path.module}/host/${script}") }], [
        { path = "/usr/local/lib/gromesh-j8/tools.lock.json", owner = "root:root", permissions = "0444", content = file("${path.module}/host/tools.lock.json") },
        { path = "/usr/local/lib/gromesh-j8/worker-bootstrap.mjs", owner = "root:root", permissions = "0444", content = file("${path.module}/../../../ci/jenkins/worker-bootstrap.mjs") },
        { path = "/etc/systemd/system/gromesh-enroll.service", owner = "root:root", permissions = "0644", content = "[Unit]\nAfter=network-online.target\nWants=network-online.target\n[Service]\nType=oneshot\nExecStart=/usr/bin/python3 /usr/local/lib/gromesh-j8/enroll.py\nTimeoutStartSec=3600\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n" }
      ]),
      runcmd = [["bash", "/usr/local/lib/gromesh-j8/prepare.sh"]]
    })}"
    gromesh-enrollment = lookup(var.public_enrollment, each.key, "{}")
  }
  lifecycle { prevent_destroy = true }
}
resource "scaleway_object_bucket" "artifacts" {
  count         = var.provisioning_approved && var.create_artifact_bucket ? 1 : 0
  name          = "${var.generation}-artifacts"
  project_id    = var.project_id
  region        = "fr-par"
  force_destroy = false
  versioning { enabled = true }
  lifecycle { prevent_destroy = true }
}
output "proposed_inventory" {
  value = { for key, node in scaleway_instance_server.node : key => { id = node.id, public_ip = scaleway_instance_ip.node[key].address, role = key, architecture = local.proposed_nodes[key].arch, overlay_ip = local.proposed_nodes[key].overlay, root_volume = node.root_volume, work_volume = try(scaleway_block_volume.work[key].id, null), qualified = false, registered_in_jenkins = false } }
}
output "artifact_admission_budget_gib" { value = var.artifact_budget_gib }

resource "scaleway_object_bucket_acl" "artifacts" {
  count      = var.provisioning_approved && var.create_artifact_bucket ? 1 : 0
  bucket     = scaleway_object_bucket.artifacts[0].name
  project_id = var.project_id
  region     = "fr-par"
  acl        = "private"
  lifecycle { prevent_destroy = true }
}
