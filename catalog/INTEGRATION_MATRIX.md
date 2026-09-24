# Complete source integration matrix

All 115 supplied package directories are retained, including version alternatives and duplicate-looking envelopes. Presence is not operational status. 448 metadata documents were inspected by the inventory pass; selected implementations were read and tested.

| Package | Plane / responsibility | Integration | Declared interfaces sampled |
|---|---|---|---|
| _model | Build / evaluation: Repository refinement and offline advisory evaluation | BOUND_SUBSET / offline evaluator; full mission unavailable | See source metadata |
| BOTTLE_ROCKET_3.0.0_MODEL_OPERATIONAL_110K | Execution: Independent custom Bottle Rocket VM package | CATALOGUED / specified adapter only | See source metadata |
| BOTTLE_ROCKET_3.0.0_MODEL_OPERATIONAL_61K (1) | Execution: Independent custom Bottle Rocket VM package | CATALOGUED / specified adapter only | See source metadata |
| DF_Fabric | Cell / execution: Federation control | CATALOGUED / specified adapter only | See source metadata |
| DF_Large | Cell / execution: Sealed compute tier | CATALOGUED / specified adapter only | See source metadata |
| DF_Medium | Cell / execution: Sealed compute tier | CATALOGUED / specified adapter only | See source metadata |
| DF_Small | Cell / execution: Sealed compute tier | CATALOGUED / specified adapter only | See source metadata |
| DF_Unified | Cell / execution: Sealed member binding | CATALOGUED / specified adapter only | See source metadata |
| DF_Unified_v1.0.0 | Cell / execution: Sealed member binding | CATALOGUED / specified adapter only | See source metadata |
| DF_Xtra_Large | Cell / execution: Sealed compute tier | CATALOGUED / specified adapter only | See source metadata |
| gap01_edge_node_supervisor_v5.0.0 | Runtime: Node supervision and lifecycle | CATALOGUED / specified adapter only | PK_DRAIN/1, PK_NODE_HEALTH/1, PK_NODE_LIFECYCLE/1 |
| gap02_hardware_capability_discovery_v4.3.0 | Execution: Hardware capability discovery | CATALOGUED / specified adapter only | PK_CAPABILITY_PROBE/1, PK_HARDWARE_INVENTORY/1, PK_NODE_CAPABILITIES/1, PK_PROBE_SCHEDULE/1 |
| gap03_topology_aware_scheduler_v4.3.0_missing_components_applied | Elasticity: Topology and fairness advice | CATALOGUED / specified adapter only | PK_FAIR_SHARE/1, PK_LOCALITY_COST/1, PK_TOPOLOGY/1 |
| gap04_disconnected_operation_controller_v4.3.0 | Runtime: Bounded disconnected autonomy | CATALOGUED / specified adapter only | PK_AUTONOMY_LEASE/1, PK_CAPABILITY_GRANT/1, PK_DEGRADATION_TIER/1, PK_GAP04_ERROR/1, PK_GAP04_HEALTH/1 (more in sources.json) |
| gap04_v4.3.0_release_evidence | Runtime: Bounded disconnected autonomy | CATALOGUED / specified adapter only | See source metadata |
| gap05_state_replication_consistency_model_v4.3.0_production_layer | Data: Causal replicated-state semantics | BOUND_CORE / causal preview only; production overlay staged | PK_CONFLICT_SET/1, PK_MERGE_RESULT/1, PK_REPLICATED_WRITE/1 |
| gap06_device_identity_and_attestation_v5.0.0_Missing_Components_Applied | Security: Device identity and attestation | CATALOGUED / specified adapter only | PK_ACCEPTED_MEASUREMENTS/1, PK_ATTESTATION/1, PK_NODE_IDENTITY/1 |
| gap07_artifact_provenance_signing_v6.0.0 | Security: Artifact provenance and signing | CATALOGUED / specified adapter only | PK_ARTIFACT_BUNDLE/1, PK_AUDIT_EVENT/1, PK_PROVENANCE/2, PK_SIGNATURE/2, PK_SIGNATURE/3 (more in sources.json) |
| gap08_ota_lifecycle_rollback_v4.3.0 | Application: OTA deployment and rollback | CATALOGUED / specified adapter only | PK_AUDIT_SEAL/1, PK_CONTROLLER_STATE/1, PK_ERROR/1, PK_HEALTH_EVIDENCE/1, PK_NODE_ACK/1 (more in sources.json) |
| gap09_unified_observability_v5.1.0_components | Operations: Unified observability | CATALOGUED / specified adapter only | PK_SIGNAL_CATALOGUE/1, PK_SIGNAL_QUERY/2, PK_SIGNAL_SUBMISSION/2 |
| gap10_power_thermal_aware_scheduling_v4.3.0 | Elasticity: Power and thermal constraints | CATALOGUED / specified adapter only | PK_POWER_CEILING/1, PK_THERMAL_POLICY/1, PK_THERMAL_STATE/1 |
| gap11_accelerator_scheduling_v4.3.0_control_plane | Elasticity: Accelerator allocation | CATALOGUED / specified adapter only | PK_ACCELERATOR_ALLOCATION/1, PK_ACCELERATOR_INVENTORY/1, PK_ACCELERATOR_RELEASE/1, PK_SCRUB/1 |
| gap12_wan_resilience_and_nat_traversal_v4.3.0_Checklist_Applied | Transport: WAN resilience, relay and NAT | CATALOGUED / specified adapter only | PK_BACKOFF/1, PK_PATH_REQUEST/1, PK_PATH_STATE/1, PK_RELAY_ACCOUNTING/1 |
| gap13_policy_engine_v5.0.0 | Security: Signed policy evaluation | CATALOGUED / specified adapter only | PK_POLICY_BUNDLE/1, PK_POLICY_ERROR/1, PK_POLICY_EXPLANATION/1, PK_POLICY_HEALTH/1, PK_POLICY_SIGNED_BUNDLE/1 (more in sources.json) |
| gap14_data_gravity_manager_v4.3.0_Overhauled | Data: Data gravity and residency | CATALOGUED / specified adapter only | PK_AUDIT_RECORD/1, PK_CONVERGENCE_PROOF/1, PK_DATASET/1, PK_DATA_MOVE_ACK/1, PK_DATA_MOVE_HANDOFF/1 (more in sources.json) |
| gap15_runtime_compatibility_certification_v4.3.0 | Execution: Runtime compatibility certification | CATALOGUED / specified adapter only | PK_CERTIFICATION/1, PK_COMPATIBILITY_MATRIX/1, PK_RUNTIME_LIFECYCLE/1 |
| hermit-ramws_2.0.0-ramws.1 | Experience / transport: RAMWS virtual terminal | DERIVED_RUNTIME / terminal, protocol and framing | See source metadata |
| inv02_container_substrate_v5.0.0 | Transition: container substrate | CATALOGUED / specified adapter only | PK_IMAGE_RESOLVE/1, PK_IMAGE_TAGPOLICY/1, PK_IMAGE_VERIFY/1 |
| inv03_container_hardening_v4.3.0 | Transition: container hardening | CATALOGUED / specified adapter only | PK_HARDEN_BASELINE/1, PK_HARDEN_EVAL/1, PK_HARDEN_EVAL/2, PK_HARDEN_EXCEPTION/1 |
| inv04_current_orchestration-4.3.0 | Transition: current orchestration | CATALOGUED / specified adapter only | PK_ORCH_DRAIN/1, PK_ORCH_ERROR/1, PK_ORCH_INVENTORY/1, PK_ORCH_RECONCILE/1 |
| inv05_current_control_state_system_v4.3.0 | Transition: current control state system | CATALOGUED / specified adapter only | PK_CSTATE_COMPACT/1, PK_CSTATE_TXN/1, PK_CSTATE_WATCH/1 |
| inv06_traditional_iac_v4.3.0 | Transition: traditional iac | CATALOGUED / specified adapter only | PK_IAC_APPLY/1, PK_IAC_DRIFT/1, PK_IAC_PLAN/1 |
| inv07_gitops_transition_layer_v5.0.0 | Transition: gitops transition layer | CATALOGUED / specified adapter only | PK_GITOPS_DRIFT/1, PK_GITOPS_SYNC/1, PK_GITOPS_VERIFY/1 |
| inv08_dynamic_infrastructure_model_v4.3.0.dev1_production_overlay | Transition: dynamic infrastructure model | CATALOGUED / specified adapter only | PK_DYN_COST/1, PK_DYN_LEASE/1, PK_DYN_SCALE/1 |
| inv09_portable_compute_isa_v4.3.0 | Application / ABI: portable compute isa | CATALOGUED / specified adapter only | PK_ISA_PROFILE/1, PK_MODULE_VALIDATION/1, PK_VALIDATION_FAILURE/1 |
| inv10_component_composition_system_v4.3.0 | Application / ABI: component composition system | CATALOGUED / specified adapter only | See source metadata |
| inv11_interface_contract_language_v4.3.0 | Application / ABI: interface contract language | CATALOGUED / specified adapter only | PK_INTERFACE/1, PK_INTERFACE_DIFF/1 |
| inv12_language_interoperability_v4.3.0_mc_applied | Application / ABI: language interoperability | CATALOGUED / specified adapter only | PK_CANONICAL_LIFT/1, PK_CANONICAL_LOWER/1, PK_INTEROP_ERROR/1, PK_TYPE_MAPPING/1 |
| inv13_system_interface_v4.3.0 | Application / ABI: system interface | CATALOGUED / specified adapter only | PK_PATH_RESOLVE/1, PK_PREOPEN/1, PK_WORLD/1 |
| inv14_previous_asynchronous_model_v4.3.0 | Application / ABI: previous asynchronous model | CATALOGUED / specified adapter only | PK_POLL/1, PK_POLLABLE/1, PK_POLL_ERROR/1, PK_POLL_METRICS/1 |
| inv15_new_asynchronous_abi_v4.3.0_checklist_applied | Application / ABI: new asynchronous abi | CATALOGUED / specified adapter only | PK_ASYNC_CALL/1, PK_SUBTASK_CANCEL/1, PK_WAITABLE_SET/1 |
| inv16_async_component_functions-4.3.0-closure | Application / ABI: async component functions | CATALOGUED / specified adapter only | PK_ASYNC_DECL/1, PK_ASYNC_INVOKE/1, PK_REENTRANCY/1 |
| inv17_streaming_primitive_v4.3.0 | Application / ABI: streaming primitive | CATALOGUED / specified adapter only | PK_STREAM/1, PK_STREAM_CLOSE/1, PK_STREAM_CREDIT/1 |
| inv18_completion_primitive-4.3.0 | Application / ABI: completion primitive | CATALOGUED / specified adapter only | PK_FUTURE/1, PK_FUTURE_ABANDON/1, PK_FUTURE_ERROR/1, PK_FUTURE_LOG/1, PK_FUTURE_RESOLVE/1 (more in sources.json) |
| inv19_os_asynchronous_analogues_v5.0.0 | Application / ABI: os asynchronous analogues | CATALOGUED / specified adapter only | PK_ASYNC_ARM/1, PK_ASYNC_BACKEND/1, PK_ASYNC_ERROR/1, PK_ASYNC_REAP/1 |
| inv20_http_component_worlds_v4.3.0 | Application / ABI: http component worlds | CATALOGUED / specified adapter only | PK_HTTP_BODY/1, PK_HTTP_HANDLER/1, PK_HTTP_OUTGOING/1 |
| inv20_http_component_worlds_v4.3.0_1 | Application / ABI: http component worlds | CATALOGUED / specified adapter only | PK_HTTP_BODY/1, PK_HTTP_HANDLER/1, PK_HTTP_OUTGOING/1 |
| inv21_local_service_chaining-4.3.0-remediated | Application / ABI: local service chaining | CATALOGUED / specified adapter only | PK_CALL_CONTEXT/1, PK_CAPABILITY/1, PK_CHAIN_AUDIT/1, PK_CHAIN_CONFIG/1, PK_CHAIN_DEPTH/1 (more in sources.json) |
| inv22_alternative_wasi_branch_v4.3.0_remediated | Application / ABI: alternative wasi branch | CATALOGUED / specified adapter only | PK_BRANCH_CERT/1, PK_BRANCH_MATRIX/1, PK_BRANCH_SHIM/1 |
| inv22_alternative_wasi_branch_v4.3.0_remediated_1 | Application / ABI: alternative wasi branch | CATALOGUED / specified adapter only | PK_BRANCH_CERT/1, PK_BRANCH_MATRIX/1, PK_BRANCH_SHIM/1 |
| inv23_hardware_virtualization_primitive_v5.0.0_remediated | Execution: hardware virtualization primitive | CATALOGUED / specified adapter only | PK_VIRT_CLAIM/2, PK_VIRT_PRIMITIVE/2 |
| inv23_hardware_virtualization_primitive_v5.0.0_remediated_1 | Execution: hardware virtualization primitive | CATALOGUED / specified adapter only | PK_VIRT_CLAIM/2, PK_VIRT_PRIMITIVE/2 |
| inv24_microvm_runtime_v4.3.0 | Execution: microvm runtime | CATALOGUED / specified adapter only | PK_MICROVM/1, PK_MICROVM_BOOT/1, PK_MICROVM_LIFECYCLE/1 |
| inv24_microvm_runtime_v4.3.0_1 | Execution: microvm runtime | CATALOGUED / specified adapter only | PK_MICROVM/1, PK_MICROVM_BOOT/1, PK_MICROVM_LIFECYCLE/1 |
| inv25_microvm_devices_v4.3.0 | Execution: microvm devices | CATALOGUED / specified adapter only | PK_DEVICE_AUDIT_EVENT/1, PK_DEVICE_CATALOGUE/1, PK_DEVICE_CONFIG_ACTIVATION/1, PK_DEVICE_ERROR/1, PK_DEVICE_SURFACE_DIFF/1 |
| inv25_microvm_devices_v4.3.0_1 | Execution: microvm devices | CATALOGUED / specified adapter only | PK_DEVICE_AUDIT_EVENT/1, PK_DEVICE_CATALOGUE/1, PK_DEVICE_CONFIG_ACTIVATION/1, PK_DEVICE_ERROR/1, PK_DEVICE_SURFACE_DIFF/1 |
| inv26_microvm_snapshotting_v6.0.0_mc_applied | Execution: microvm snapshotting | CATALOGUED / specified adapter only | PK_SNAPSHOT/2, PK_SNAPSHOT_CONFIG/1, PK_SNAPSHOT_ERROR/1, PK_SNAPSHOT_MANIFEST/1, PK_SNAPSHOT_RESTORE/2 (more in sources.json) |
| inv27_unikernel_execution_v4.3.0 | Execution: unikernel execution | CATALOGUED / specified adapter only | PK_UNIKERNEL_IMAGE/1, PK_UNIKERNEL_INSTANCE/1, PK_UNIKERNEL_SEAL_MANIFEST/1 |
| inv28_unikernel_implementations_v4.3.0_remediated | Execution: unikernel implementations | CATALOGUED / specified adapter only | PK_TOOLCHAIN/1, PK_TOOLCHAIN/2, PK_TOOLCHAIN_POLICY/1, PK_TOOLCHAIN_REFUSAL/1, PK_TOOLCHAIN_REGISTRY/1 (more in sources.json) |
| inv29_hybrid_wasm_unikernel_v4.3.0 | Execution: hybrid wasm unikernel | CATALOGUED / specified adapter only | PK_HYBRID_COMPOSITION/1, PK_HYBRID_VERIFICATION/1 |
| inv29_hybrid_wasm_unikernel_v4.3.0_1 | Execution: hybrid wasm unikernel | CATALOGUED / specified adapter only | PK_HYBRID_COMPOSITION/1, PK_HYBRID_VERIFICATION/1 |
| inv30_capability_hardware_sandbox_v4.2.0_hardened(1) | Execution: capability hardware sandbox | CATALOGUED / specified adapter only | PK_CAPABILITY/1, PK_CAPABILITY_ACCESS/1 |
| inv30_capability_hardware_sandbox_v4.3.0 | Execution: capability hardware sandbox | CATALOGUED / specified adapter only | PK_CAPABILITY/1, PK_CAPABILITY_ACCESS/1, PK_FAILURE/1 |
| inv30_capability_hardware_sandbox_v4.3.0_1 | Execution: capability hardware sandbox | CATALOGUED / specified adapter only | PK_CAPABILITY/1, PK_CAPABILITY_ACCESS/1, PK_FAILURE/1 |
| inv31_function_execution_architecture_v4.3.0_remediated | Execution: function execution architecture | CATALOGUED / specified adapter only | PK_FUNCTION_POOL/1, PK_INV31_CONFIG/1, PK_INV31_ERROR/1, PK_INVOCATION/1 |
| inv32_elastic_virtualization_v4.3.0 | Execution: elastic virtualization | CATALOGUED / specified adapter only | PK_HOST_RESOURCES/1, PK_RESOURCE_ADJUSTMENT/2, PK_RESOURCE_AUDIT/1 |
| inv34_legacy_cpu_expansion_path_v5.1.0 | Execution: legacy cpu expansion path | CATALOGUED / specified adapter only | PK_CPU_EXPANSION_REQUEST/1, PK_CPU_EXPANSION_RESULT/1, PK_CPU_EXPANSION_STATUS/1 |
| inv35_high_performance_vm_i_o_v4.3.0 | Execution: high performance vm i o | CATALOGUED / specified adapter only | PK_VIRTQUEUE_COMPLETE/1, PK_VIRTQUEUE_SUBMIT/1 |
| inv36_control_transport_v5.1.0_mc_applied | Transport / data: control transport | CATALOGUED / specified adapter only | PK_CTRL_FRAME/1, PK_CTRL_FRAME/2, PK_CTRL_HS/1, PK_CTRL_MSG/1, PK_CTRL_RELAY/1 (more in sources.json) |
| inv37_bulk_data_plane_v4.3.0_remediated | Transport / data: bulk data plane | CATALOGUED / specified adapter only | PK_BULK_CHUNK/1, PK_BULK_MANIFEST/1, PK_BULK_RESUME/1 |
| inv38_kernel_bypass_transport_v4.2.0_remediated | Transport / data: kernel bypass transport | CATALOGUED / specified adapter only | PK_BYPASS_CQ/1, PK_BYPASS_MR/1, PK_BYPASS_POST/1 |
| inv39_process_sandbox_tier_v5.1.0 | Execution / security: process sandbox tier | CATALOGUED / specified adapter only | PK_SANDBOX_APPLIED/1, PK_SANDBOX_APPLIED/2, PK_SANDBOX_ERROR/1, PK_SANDBOX_PROFILE/1, PK_SANDBOX_STATUS/1 |
| inv40_full_virtualization_tier_v4.3.0_mc_applied | Execution / security: full virtualization tier | CATALOGUED / specified adapter only | PK_FULL_VM/1, PK_FULL_VM_BOOT/1, PK_FULL_VM_ERROR/1, PK_FULL_VM_STATE/1 |
| inv41_capability_security_v4.3.0_remediated | Execution / security: capability security | CATALOGUED / specified adapter only | PK_MEMBRANE/1, PK_REFERENCE/1 |
| inv42_capability_descriptors_v4.3.0_remediated | Execution / security: capability descriptors | CATALOGUED / specified adapter only | PK_DESCRIPTOR/2, PK_DESCRIPTOR_CLOSE/2, PK_DESCRIPTOR_RESOLVE/2, PK_DESCRIPTOR_TABLE_STATUS/1, PK_DESCRIPTOR_TRANSPORT/1 |
| inv43_transient_execution_defense_v4.3.0_remediated | Execution / security: transient execution defense | CATALOGUED / specified adapter only | PK_ATTESTED_READBACK/1, PK_COTENANCY/1, PK_ERROR/1, PK_MITIGATIONS/1, PK_MITIGATIONS/2 (more in sources.json) |
| inv44_wasm_hardening_system_v4.3.0 | Execution / security: wasm hardening system | CATALOGUED / specified adapter only | PK_WASM_HARDENING/1, PK_WASM_INSTANCE/1 |
| inv45_sfi_mechanisms_v4.3.0 | Execution / security: sfi mechanisms | CATALOGUED / specified adapter only | PK_SFI_MASK/1, PK_SFI_MODULE/1 |
| inv52_messaging_abstraction_v4.3.0 | Runtime / messaging: messaging abstraction | CATALOGUED / specified adapter only | PK_MSG_CONFIG/1, PK_MSG_ENVELOPE/1, PK_MSG_PUBLISH/1, PK_MSG_SUBSCRIBE/1 |
| inv53_message_reliability_v5.1.0 | Runtime / messaging: message reliability | CATALOGUED / specified adapter only | PK_MSG_ACK/1, PK_MSG_DELIVER/1, PK_MSG_DLQ/1, PK_MSG_EXTEND_VISIBILITY/1, PK_MSG_NACK/1 |
| inv54_broker_implementations_v4.3.0 | Runtime / messaging: broker implementations | CATALOGUED / specified adapter only | PK_BROKER_FANOUT/1, PK_BROKER_LOG/1, PK_BROKER_OFFSET/1 |
| inv55_secrets_integration_v4.3.0 | Security: secrets integration | CATALOGUED / specified adapter only | PK_SECRET_ERROR/1, PK_SECRET_RESOLVE/1, PK_SECRET_ROTATE/1, PK_SECRET_SCOPE/1 |
| inv55_secrets_integration_v4.3.0_checklist_applied_1 | Security: secrets integration | CATALOGUED / specified adapter only | PK_SECRET_RESOLVE/1, PK_SECRET_ROTATE/1, PK_SECRET_SCOPE/1 |
| inv57_durable_execution_v4.3.0_remediated | Runtime / durability: durable execution | CATALOGUED / specified adapter only | PK_WF_ACTIVITY/1, PK_WF_HISTORY/1, PK_WF_REPLAY/1 |
| inv58_existing_service_mesh_layer_v4.3.0 | Transition: existing service mesh layer | CATALOGUED / specified adapter only | PK_MESH_BYPASS/1, PK_MESH_CONFIG/1, PK_MESH_ERROR/1, PK_MESH_IDENTITY/1, PK_MESH_RECONCILE/1 |
| inv60_wasm_application_fabric_v4.3.0 | Application / runtime: wasm application fabric | CATALOGUED / specified adapter only | PK_LATTICE_CALL/1, PK_LATTICE_LINK/1, PK_LATTICE_START/1 |
| inv61_distributed_wit_rpc_v4.3.0 | Application / runtime: distributed wit rpc | CATALOGUED / specified adapter only | PK_WRPC_DEADLINE/1, PK_WRPC_ERROR/1, PK_WRPC_FRAME/1, PK_WRPC_FRAME/2 |
| inv61_distributed_wit_rpc_v4.3.0_1 | Application / runtime: distributed wit rpc | CATALOGUED / specified adapter only | PK_WRPC_DEADLINE/1, PK_WRPC_ERROR/1, PK_WRPC_FRAME/1, PK_WRPC_FRAME/2 |
| inv62_edge_topology_v4.3.0 | Application / runtime: edge topology | CATALOGUED / specified adapter only | PK_TOPO_GRAPH/1, PK_TOPO_NEAREST/1, PK_TOPO_PARTITION/1 |
| inv63_wasm_deployment_manager_v4.3.0_remediated | Application / runtime: wasm deployment manager | CATALOGUED / specified adapter only | PK_DEPLOY_DESIRED/1, PK_DEPLOY_DIFF/1, PK_DEPLOY_GATE/1, PK_DEPLOY_ROLLOUT/1 |
| inv64_application_model_v4.3.0_mc_applied | Application / runtime: application model | CATALOGUED / specified adapter only | PK_APP_AUDIT/1, PK_APP_CANONICAL/1, PK_APP_DECISION/1, PK_APP_ERROR/1, PK_APP_MANIFEST/1 (more in sources.json) |
| inv65_capability_providers_v4.3.0_1 | Application / runtime: capability providers | CATALOGUED / specified adapter only | PK_PROVIDER_CONTRACT/1, PK_PROVIDER_HEALTH/1, PK_PROVIDER_LINK/1 |
| inv66_enterprise_wasm_control_plane_v4.3.0 | Application / runtime: enterprise wasm control plane | CATALOGUED / specified adapter only | See source metadata |
| inv66_enterprise_wasm_control_plane_v4.3.0_1 | Application / runtime: enterprise wasm control plane | CATALOGUED / specified adapter only | PK_ECP_ADMIT/1, PK_ECP_AUDIT/1, PK_ECP_AUDIT/2, PK_ECP_CONFIG/1, PK_ECP_DELIVER/1 (more in sources.json) |
| inv67_kubernetes_integration_mechanism_v4.3.0_checklist_applied_2 | Transition: kubernetes integration mechanism | CATALOGUED / specified adapter only | PK_K8S_REFUSE/1, PK_K8S_STATUS/1, PK_K8S_TRANSLATE/1 |
| inv68_resource_packing_v4.3.0_mc_applied | Placement: resource packing | CATALOGUED / specified adapter only | PK_PACK/1, PK_PACK_AUDIT/1, PK_PACK_CAPACITY/1, PK_PACK_CONFIG/1, PK_PACK_ERROR/1 (more in sources.json) |
| inv69_agentic_workload_layer_v4.3.0_remediated | Execution / agents: agentic workload layer | CATALOGUED / specified adapter only | PK_AGENT_APPROVAL/1, PK_AGENT_STEP/1, PK_AGENT_TRANSCRIPT/1 |
| inv70_fast_agent_sandbox_v4.3.0_remediated | Execution / agents: fast agent sandbox | CATALOGUED / specified adapter only | PK_FASTBOX_HOSTCALL/1, PK_FASTBOX_RESULT/1, PK_FASTBOX_RUN/1 |
| inv71_heavy_agent_sandbox_v4.3.0_remediated | Execution / agents: heavy agent sandbox | CATALOGUED / specified adapter only | PK_HEAVYBOX_EGRESS/1, PK_HEAVYBOX_SESSION/1, PK_HEAVYBOX_TEARDOWN/1 |
| inv72_accelerated_workload_requirement_v4.3.0_remediated | Execution / agents: accelerated workload requirement | CATALOGUED / specified adapter only | PK_ACCEL_AUDIT_EVENT/1, PK_ACCEL_CONFIG/1, PK_ACCEL_ERROR/1, PK_ACCEL_INVENTORY/1, PK_ACCEL_MATCH/1 (more in sources.json) |
| iOS735_LCTL_v0.1.0 | Experience: Native mobile structural/lifecycle contracts | CATALOGUED / specified adapter only | See source metadata |
| iOS735_LCTL_v0.2.0-candidate | Experience: Native mobile structural/lifecycle contracts | CATALOGUED / specified adapter only | See source metadata |
| LinearAndroid_LCTL_v0.1.0 | Experience: Native mobile structural/lifecycle contracts | CATALOGUED / specified adapter only | See source metadata |
| pln01_intent_plane_v4.3.0 | Intent: Intent plane | CATALOGUED / specified adapter only | PK_ACTUAL_STATE/1, PK_DECLARATION/1, PK_INTENT_GRAPH/1, PK_RECONCILIATION_PLAN/1 |
| pln02_application_plane_v4.3.0 | Application: Application plane | CATALOGUED / specified adapter only | PK_APPLICATION/1, PK_APPLICATION_REVISION/1, PK_ERROR/1, PK_PLANE_CONFIG/1, PK_PROVIDER_CATALOGUE/1 (more in sources.json) |
| pln03_distributed_runtime_plane_v4.3.0 | Runtime: Distributed runtime plane | CATALOGUED / specified adapter only | PK_INVOKE/1, PK_MESSAGE/1, PK_SECRET/1, PK_STATE/1 |
| pln04_execution_plane_v4.3.0_remediated | Execution: Execution plane | CATALOGUED / specified adapter only | PK_ADMISSION/1, PK_PLANE_CONFIG/1, PK_TIER_CATALOGUE/1, PK_TIER_LIFECYCLE/1 |
| pln05_elasticity_plane_v4.2.0_mc_applied | Elasticity: Elasticity plane | CATALOGUED / specified adapter only | PK_CAPACITY_LIMITS/1, PK_CAPACITY_TARGET/1, PK_DEMAND/1, PK_ERROR/1 |
| pln05_elasticity_plane_v4.2.0_mc_applied_1 | Elasticity: Elasticity plane | CATALOGUED / specified adapter only | PK_CAPACITY_LIMITS/1, PK_CAPACITY_TARGET/1, PK_DEMAND/1, PK_ERROR/1 |
| pln06_data_plane_v4.3.0 | Data: Data plane | CATALOGUED / specified adapter only | PK_AUDIT_RECORD/1, PK_DATA_PLANE_CONFIG/1, PK_DATA_PLANE_EXPLAIN/1, PK_DATA_PLANE_HEALTH/1, PK_DATA_PLANE_METRICS/1 (more in sources.json) |
| pln07_security_plane_v4.3.0 | Security: Security plane | CATALOGUED / specified adapter only | PK_GRANT/1, PK_GRANT/2, PK_GRANT_VERIFICATION/1, PK_REVOCATION/1, PK_SIG/1 |
| QVM_Quantum_VM_v8.1.0-alpha | Execution: Experimental quantum VM capability candidate | CATALOGUED / specified adapter only | See source metadata |
| RODEO | Build: Reproducible task/build graph | CATALOGUED / specified adapter only | See source metadata |
| sch01_workload_classification_and_runtime_placem_v4.3.0 | Placement: Canonical workload classification and final selection | BOUND_CORE / actual placement | PK_NODE_REPORT/1, PK_PLACEMENT/1, PK_SCHEDULER_ERROR/1, PK_WORKLOAD_CLASS/1 |
| UC32_rc9_ACF_WEB_Applied_Candidate(1) | Cell authority: Cubby composition and authority boundary | CATALOGUED / specified adapter only | See source metadata |

## Selection and duplicate policy

The runtime bindings select exact source hashes, not the largest version number or a suffix convention. DF sealed membership pins outrank sibling-package version names. No duplicate directory was discarded. A matching README is evidence of matching documentation only, not binary, manifest or gate equivalence. The source snapshot contains embedded components that are not standalone entries in the user list; they are not silently substituted for missing certified services.
