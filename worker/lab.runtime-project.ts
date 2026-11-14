/**
 * Type-only view used when RuntimeEnv resolves the Lab callback service binding.
 * The Runtime project owns the binding contract, not the Lab implementation tree.
 */
declare const labWorkerServiceEntrypoint: ExportedHandler;

export default labWorkerServiceEntrypoint;
