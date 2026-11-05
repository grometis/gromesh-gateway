mock_provider "scaleway" {
  override_during = plan
  mock_resource "scaleway_instance_ip" {
    defaults = { address = "203.0.113.20", id = "fr-par-2/44444444-4444-4444-8444-444444444444" }
  }
  mock_resource "scaleway_block_volume" {
    defaults = { id = "fr-par-2/55555555-5555-4555-8555-555555555555" }
  }
}
variables {
  project_id           = "11111111-1111-4111-8111-111111111111"
  generation           = "gromesh-j8-20261105a"
  operator_cidr        = "203.0.113.10/32"
  admin_ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA fixture-only"
  image_ids = {
    amd64 = "22222222-2222-4222-8222-222222222222"
    arm64 = "33333333-3333-4333-8333-333333333333"
  }
}
run "default_creates_nothing" {
  command = plan
  assert {
    condition     = length(scaleway_instance_server.node) == 0 && length(scaleway_instance_ip.node) == 0 && length(scaleway_block_volume.work) == 0 && length(scaleway_instance_security_group.node) == 0 && length(scaleway_object_bucket.artifacts) == 0 && length(scaleway_object_bucket_acl.artifacts) == 0
    error_message = "Default must have an entirely empty paid-resource graph."
  }
}
run "approved_fixture_native_pair" {
  command = plan
  variables { provisioning_approved = true }
  assert {
    condition     = length(scaleway_instance_server.node) == 3 && length(scaleway_block_volume.work) == 3 && length(scaleway_instance_ip.node) == 3
    error_message = "Mock plan must contain exactly native pair plus coordinator and owned volumes/IPs."
  }
  assert {
    condition     = scaleway_instance_server.node["pr-amd64"].type == "BASIC3-X8C-32G" && scaleway_instance_server.node["pr-arm64"].type == "BASIC2-A8C-32G"
    error_message = "Native architecture types cannot be substituted."
  }
  assert {
    condition     = alltrue([for node in scaleway_instance_server.node : node.root_volume[0].volume_type == "sbs_volume" && node.root_volume[0].size_in_gb == 35 && node.root_volume[0].delete_on_termination == false && node.protected])
    error_message = "Boot disks and protection must remain explicit."
  }
  assert {
    condition     = alltrue([for k, volume in scaleway_block_volume.work : volume.size_in_gb == (k == "coordinator" ? 35 : 216) && volume.iops == 5000])
    error_message = "216 decimal GB provides at least200GiB; don't silently shrink."
  }
  assert {
    condition     = alltrue([for group in scaleway_instance_security_group.node : group.inbound_default_policy == "drop" && group.outbound_default_policy == "drop" && group.stateful && alltrue([for rule in group.inbound_rule : rule.protocol == "UDP" && rule.port == 51820])])
    error_message = "Never open public SSH/remoting; only encrypted overlay UDP."
  }
  assert {
    condition     = length(scaleway_object_bucket.artifacts) == 0 && length(scaleway_object_bucket_acl.artifacts) == 0
    error_message = "Compute approval does not silently approve a bucket."
  }
}
run "cloud_init_is_inactive_and_root_scoped" {
  command = plan
  variables { provisioning_approved = true }
  assert {
    condition     = alltrue([for n in scaleway_instance_server.node : yamldecode(n.user_data["cloud-init"]).disable_root && !yamldecode(n.user_data["cloud-init"]).ssh_pwauth && alltrue([for f in yamldecode(n.user_data["cloud-init"]).write_files : f.owner == "root:root"])])
    error_message = "Cloud-init must contain only root-scoped public configuration with password/root login disabled."
  }
}
run "foreign_zone" {
  command = plan
  variables { zone = "nl-ams-1" }
  expect_failures = [var.zone]
}
run "global_operator_route" {
  command = plan
  variables { operator_cidr = "0.0.0.0/0" }
  expect_failures = [var.operator_cidr]
}
run "moving_image" {
  command = plan
  variables { image_ids = { amd64 = "ubuntu_noble", arm64 = "ubuntu_noble" } }
  expect_failures = [var.image_ids]
}
run "invalid_generation" {
  command = plan
  variables { generation = "gromesh-n2-lab" }
  expect_failures = [var.generation]
}
run "unknown_state" {
  command = plan
  variables { worker_state = "standby" }
  expect_failures = [var.worker_state]
}
run "oversized_pilot" {
  command = plan
  variables { artifact_budget_gib = 2400 }
  expect_failures = [var.artifact_budget_gib]
}
