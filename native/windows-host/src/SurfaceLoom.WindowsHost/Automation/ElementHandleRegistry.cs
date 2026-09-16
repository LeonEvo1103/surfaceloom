namespace SurfaceLoom.WindowsHost.Automation;

internal sealed class ElementHandleRegistry<TElement>
    where TElement : class
{
    private readonly int capacity;
    private readonly Dictionary<string, TElement> elementsByHandle = new(StringComparer.Ordinal);
    private readonly Dictionary<int[], string> handlesByRuntimeId = new(RuntimeIdComparer.Instance);
    private readonly Dictionary<string, int[]> runtimeIdsByHandle = new(StringComparer.Ordinal);

    public ElementHandleRegistry(int capacity)
    {
        if (capacity <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(capacity));
        }

        this.capacity = capacity;
    }

    public int Count => elementsByHandle.Count;

    public bool TryRemember(
        IReadOnlyList<int> runtimeId,
        TElement element,
        out string elementId)
    {
        ArgumentNullException.ThrowIfNull(runtimeId);
        ArgumentNullException.ThrowIfNull(element);
        if (runtimeId.Count == 0)
        {
            throw new ArgumentException("RuntimeId must not be empty.", nameof(runtimeId));
        }

        var lookup = runtimeId as int[] ?? runtimeId.ToArray();
        if (handlesByRuntimeId.TryGetValue(lookup, out elementId!))
        {
            elementsByHandle[elementId] = element;
            return true;
        }

        if (elementsByHandle.Count >= capacity)
        {
            elementId = string.Empty;
            return false;
        }

        elementId = Guid.NewGuid().ToString("N");
        handlesByRuntimeId.Add(lookup.ToArray(), elementId);
        elementsByHandle.Add(elementId, element);
        runtimeIdsByHandle.Add(elementId, lookup.ToArray());
        return true;
    }

    public bool TryRememberBatch(
        IReadOnlyList<(IReadOnlyList<int> RuntimeId, TElement Element)> entries,
        out IReadOnlyList<string> elementIds)
    {
        ArgumentNullException.ThrowIfNull(entries);
        var normalized = entries.Select(entry =>
        {
            ArgumentNullException.ThrowIfNull(entry.RuntimeId);
            ArgumentNullException.ThrowIfNull(entry.Element);
            if (entry.RuntimeId.Count == 0)
            {
                throw new ArgumentException(
                    "RuntimeId must not be empty.",
                    nameof(entries));
            }
            return (RuntimeId: entry.RuntimeId.ToArray(), entry.Element);
        }).ToArray();

        var newRuntimeIds = new HashSet<int[]>(RuntimeIdComparer.Instance);
        foreach (var entry in normalized)
        {
            if (!handlesByRuntimeId.ContainsKey(entry.RuntimeId))
            {
                _ = newRuntimeIds.Add(entry.RuntimeId);
            }
        }
        if (elementsByHandle.Count + newRuntimeIds.Count > capacity)
        {
            elementIds = Array.Empty<string>();
            return false;
        }

        var remembered = new string[normalized.Length];
        for (var index = 0; index < normalized.Length; index++)
        {
            var entry = normalized[index];
            if (handlesByRuntimeId.TryGetValue(entry.RuntimeId, out var existing))
            {
                elementsByHandle[existing] = entry.Element;
                remembered[index] = existing;
                continue;
            }

            var elementId = Guid.NewGuid().ToString("N");
            handlesByRuntimeId.Add(entry.RuntimeId, elementId);
            elementsByHandle.Add(elementId, entry.Element);
            runtimeIdsByHandle.Add(elementId, entry.RuntimeId.ToArray());
            remembered[index] = elementId;
        }
        elementIds = remembered;
        return true;
    }

    public bool TryResolve(string elementId, out TElement? element) =>
        elementsByHandle.TryGetValue(elementId, out element);

    public bool TryResolve(
        string elementId,
        out TElement? element,
        out IReadOnlyList<int>? runtimeId)
    {
        if (elementsByHandle.TryGetValue(elementId, out element) &&
            runtimeIdsByHandle.TryGetValue(elementId, out var storedRuntimeId))
        {
            runtimeId = storedRuntimeId.ToArray();
            return true;
        }
        element = null;
        runtimeId = null;
        return false;
    }

    public void Clear()
    {
        handlesByRuntimeId.Clear();
        elementsByHandle.Clear();
        runtimeIdsByHandle.Clear();
    }

    private sealed class RuntimeIdComparer : IEqualityComparer<int[]>
    {
        public static RuntimeIdComparer Instance { get; } = new();

        public bool Equals(int[]? left, int[]? right) =>
            ReferenceEquals(left, right) ||
            left is not null && right is not null && left.AsSpan().SequenceEqual(right);

        public int GetHashCode(int[] value)
        {
            var hash = new HashCode();
            foreach (var part in value)
            {
                hash.Add(part);
            }
            return hash.ToHashCode();
        }
    }
}
