import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { statusRpc } from "../shared/rpc";

const STATUS_INTERVAL_MS = 2_500;

/**
 * Polls the plugin's daemon code for the keypad status while a surface is visible.
 * The key includes the host, so that surfaces for different hosts keep separate statuses.
 */
export function useKeypadStatus(hostId: string) {
  const status = useRpc(statusRpc);
  return useQuery({
    queryKey: ["creator-micro", hostId, "status"],
    queryFn: () => status({}),
    refetchInterval: STATUS_INTERVAL_MS,
  });
}
