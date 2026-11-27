namespace SurfaceLoom.WindowsHost.ContractTests;

/// <summary>
/// Thrown by an opt-in test that was not enabled. The runner reports it as SKIP: neither a pass nor a failure,
/// and it does not change the exit code.
/// </summary>
internal sealed class ContractTestSkippedException(string reason) : Exception(reason);
