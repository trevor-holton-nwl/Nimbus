export function createDragGate() {
    let active = false;
    return {
        get active() { return active; },
        begin() { if (active)
            return false; active = true; return true; },
        end() { if (!active)
            return false; active = false; return true; },
    };
}
