import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { GithubDeviceAuthResponse } from "@getpaseo/protocol/messages";
import * as Clipboard from "expo-clipboard";
import { Copy, Github, Link2 } from "lucide-react-native";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Linking, Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";

type AuthState = GithubDeviceAuthResponse["payload"] | { status: "error"; message: string };

export function GithubDeviceAuthPrompt({
  serverId,
  onAuthenticated,
  style,
}: {
  serverId: string;
  onAuthenticated: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const client = useHostRuntimeClient(serverId);
  const [state, setState] = useState<AuthState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setState(null);
  }, [serverId]);

  useEffect(() => {
    if (!client || state?.status !== "pending") return;
    let active = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await client.githubDeviceAuth("status");
        if (!active) return;
        setState(next);
        if (next.status === "authenticated") onAuthenticated();
      } catch {
        if (active) {
          setState({
            status: "error",
            message: "Unable to check GitHub authorization. Try again.",
          });
        }
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, onAuthenticated, state?.status]);

  const start = useCallback(async () => {
    if (!client || busy) return;
    setBusy(true);
    try {
      const next = await client.githubDeviceAuth("start");
      setState(next);
      if (next.status === "authenticated") onAuthenticated();
    } catch {
      setState({ status: "error", message: "Unable to start GitHub authorization. Try again." });
    } finally {
      setBusy(false);
    }
  }, [busy, client, onAuthenticated]);

  const cancel = useCallback(async () => {
    if (!client) return;
    try {
      setState(await client.githubDeviceAuth("cancel"));
    } catch {
      setState(null);
    }
  }, [client]);

  const copyCode = useCallback(() => {
    if (state?.status === "pending") void Clipboard.setStringAsync(state.userCode);
  }, [state]);
  const openGithub = useCallback(() => {
    if (state?.status === "pending") {
      void Linking.openURL(state.verificationUrl).catch(() => undefined);
    }
  }, [state]);

  let content: ReactNode;
  if (state?.status === "pending") {
    content = (
      <>
        <Text style={styles.description}>Enter this one-time code at github.com/login/device:</Text>
        <Text selectable style={styles.code} testID="github-device-auth-code">
          {state.userCode}
        </Text>
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            onPress={copyCode}
            style={styles.button}
            testID="github-device-auth-copy"
          >
            <Copy size={16} color="white" />
            <Text style={styles.buttonText}>Copy code</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={openGithub}
            style={styles.button}
            testID="github-device-auth-open"
          >
            <Link2 size={16} color="white" />
            <Text style={styles.buttonText}>Open GitHub</Text>
          </Pressable>
        </View>
        <Pressable accessibilityRole="button" onPress={cancel} testID="github-device-auth-cancel">
          <Text style={styles.secondary}>Cancel</Text>
        </Pressable>
      </>
    );
  } else if (state?.status === "authenticated") {
    content = <Text style={styles.description}>Connected. Loading GitHub...</Text>;
  } else {
    content = (
      <>
        <Text style={styles.description}>
          Authorize this host in your browser to access your GitHub repositories.
        </Text>
        {state?.status === "error" ? <Text style={styles.error}>{state.message}</Text> : null}
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={start}
          style={styles.button}
          testID="github-device-auth-connect"
        >
          <Github size={16} color="white" />
          <Text style={styles.buttonText}>{busy ? "Starting..." : "Connect GitHub"}</Text>
        </Pressable>
      </>
    );
  }

  return (
    <View style={[styles.root, style]} testID="github-device-auth-prompt">
      <Text style={styles.title}>Connect GitHub</Text>
      {content}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    padding: theme.spacing[4],
    gap: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  description: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  code: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.semibold,
    letterSpacing: 2,
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  button: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.success,
  },
  buttonText: { color: "white", fontSize: theme.fontSize.sm },
  secondary: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
