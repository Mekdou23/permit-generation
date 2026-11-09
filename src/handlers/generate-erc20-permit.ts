import { MaxUint256, PermitTransferFrom, SignatureTransfer } from "@uniswap/permit2-sdk";
import { ethers, utils } from "ethers";
import { PERMIT2_ADDRESS, PermitReward, TokenType } from "../types";
import { Context, Logger } from "../types/context";
import { decrypt, parseDecryptedPrivateKey } from "../utils";
import { getRpcProvider } from "../utils/get-fastest-provider";

export interface Payload {
  evmNetworkId: number;
  evmPrivateEncrypted: string;
  walletAddress: string;
  issueNodeId: string;
  logger: Logger;
  userId: number;
  transfer?: boolean;
  kernelFeeRate?: number;
  kernelFeeRecipient?: string;
}

const DEFAULT_KERNEL_FEE_RECIPIENT = "ubq.eth";

interface ResolvedPermitInput {
  logger: Logger;
  walletAddress: string | null | undefined;
  issueNodeId: string;
  evmNetworkId: number;
  evmPrivateEncrypted: string;
  userId: number;
  shouldTransfer: boolean;
  kernelFeeRate: number;
  kernelFeeRecipient: string;
}

function resolveEnvFeeRate(value: unknown): number {
  const raw = value ?? process.env.KERNEL_FEE_RATE;
  const parsed = raw !== undefined ? Number(raw) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveIssueNodeId(payload: Context["payload"]): string {
  if ("issue" in payload) {
    return payload.issue.node_id;
  }
  if ("pull_request" in payload) {
    return payload.pull_request.node_id;
  }
  throw new Error("Issue Id is missing");
}

async function resolvePermitInput(contextOrPayload: Context | Payload, username: string): Promise<ResolvedPermitInput> {
  if ("issueNodeId" in contextOrPayload) {
    return {
      logger: contextOrPayload.logger,
      walletAddress: contextOrPayload.walletAddress,
      evmNetworkId: contextOrPayload.evmNetworkId,
      evmPrivateEncrypted: contextOrPayload.evmPrivateEncrypted,
      issueNodeId: contextOrPayload.issueNodeId,
      userId: contextOrPayload.userId,
      shouldTransfer: Boolean(contextOrPayload.transfer),
      kernelFeeRate: resolveEnvFeeRate(contextOrPayload.kernelFeeRate),
      kernelFeeRecipient: contextOrPayload.kernelFeeRecipient ?? process.env.KERNEL_FEE_RECIPIENT ?? DEFAULT_KERNEL_FEE_RECIPIENT,
    };
  }

  const { config, logger } = contextOrPayload;
  const { data: userData } = await contextOrPayload.octokit.rest.users.getByUsername({ username });
  if (!userData) {
    throw new Error(`GitHub user was not found for id ${username}`);
  }
  const walletAddress = await contextOrPayload.adapters.supabase.wallet.getWalletByUserId(userData.id);
  return {
    logger,
    walletAddress,
    evmNetworkId: config.evmNetworkId,
    evmPrivateEncrypted: config.evmPrivateEncrypted,
    issueNodeId: resolveIssueNodeId(contextOrPayload.payload),
    userId: userData.id,
    shouldTransfer: Boolean(config.transfer),
    kernelFeeRate: resolveEnvFeeRate(contextOrPayload.env?.KERNEL_FEE_RATE),
    kernelFeeRecipient: contextOrPayload.env?.KERNEL_FEE_RECIPIENT ?? process.env.KERNEL_FEE_RECIPIENT ?? DEFAULT_KERNEL_FEE_RECIPIENT,
  };
}

export async function generateErc20PermitSignature(payload: Payload, username: string, amount: number, tokenAddress: string): Promise<PermitReward>;
export async function generateErc20PermitSignature(context: Context, username: string, amount: number, tokenAddress: string): Promise<PermitReward>;
export async function generateErc20PermitSignature(
  contextOrPayload: Context | Payload,
  username: string,
  amount: number,
  tokenAddress: string
): Promise<PermitReward> {
  const {
    logger,
    walletAddress,
    issueNodeId,
    evmNetworkId,
    evmPrivateEncrypted,
    userId,
    shouldTransfer,
    kernelFeeRate,
    kernelFeeRecipient,
  } = await resolvePermitInput(contextOrPayload, username);

  if (!username) {
    throw new Error("User was not found");
  }
  if (!walletAddress) {
    const errorMessage = "ERC20 Permit generation error: Wallet not found";
    logger.error(errorMessage);
    throw new Error(errorMessage);
  }

  const provider = await getRpcProvider(evmNetworkId);
  if (!provider) {
    logger.error("Provider is not defined");
    throw new Error("Provider is not defined");
  }

  const privateKey = await getPrivateKey(evmPrivateEncrypted, logger);
  const adminWallet = await getAdminWallet(privateKey, provider, logger);
  const tokenDecimals = await getTokenDecimals(tokenAddress, provider, logger);

  const permitTransferFromData: PermitTransferFrom = {
    permitted: {
      token: tokenAddress,
      amount: utils.parseUnits(amount.toString(), tokenDecimals),
    },
    spender: walletAddress,
    nonce: BigInt(utils.keccak256(utils.toUtf8Bytes(`${userId}-${issueNodeId}`))),
    deadline: MaxUint256,
  };

  const { domain, types, values } = SignatureTransfer.getPermitData(permitTransferFromData, PERMIT2_ADDRESS, evmNetworkId);

  try {
    const signature = await adminWallet._signTypedData(domain, types, values);

    const erc20Permit: PermitReward = {
      tokenType: TokenType.ERC20,
      tokenAddress: permitTransferFromData.permitted.token,
      beneficiary: permitTransferFromData.spender,
      nonce: permitTransferFromData.nonce.toString(),
      deadline: permitTransferFromData.deadline.toString(),
      amount: permitTransferFromData.permitted.amount.toString(),
      owner: adminWallet.address,
      signature: signature,
      networkId: evmNetworkId,
    };

    logger.info("Generated ERC20 permit2 signature", erc20Permit);

    if (shouldTransfer) {
      const transferResult = await executeAutomaticErc20Transfer(
        adminWallet,
        provider,
        tokenAddress,
        walletAddress,
        ethers.BigNumber.from(permitTransferFromData.permitted.amount),
        kernelFeeRate,
        kernelFeeRecipient,
        logger
      );
      erc20Permit.transactionHash = transferResult.transactionHash;
      if (transferResult.feeTransactionHash) {
        erc20Permit.feeTransactionHash = transferResult.feeTransactionHash;
      }
    }

    return erc20Permit;
  } catch (error) {
    logger.error(`Failed to sign typed data: ${error}`);
    throw error;
  }
}

async function executeAutomaticErc20Transfer(
  adminWallet: ethers.Wallet,
  provider: ethers.providers.Provider,
  tokenAddress: string,
  beneficiaryAddress: string,
  totalAmount: ethers.BigNumber,
  kernelFeeRate: number,
  kernelFeeRecipient: string,
  logger: Logger
): Promise<{ transactionHash: string; feeTransactionHash?: string }> {
  if (kernelFeeRate < 0 || kernelFeeRate > 1) {
    throw new Error(`Invalid kernel fee rate: ${kernelFeeRate}`);
  }

  const erc20TransferAbi = ["function transfer(address to, uint256 amount) public returns (bool)"];
  const tokenContract = new ethers.Contract(tokenAddress, erc20TransferAbi, adminWallet);

  const basisPoints = Math.round(kernelFeeRate * 10000);
  const feeAmount = basisPoints > 0 ? totalAmount.mul(basisPoints).div(10000) : ethers.BigNumber.from(0);
  const beneficiaryAmount = totalAmount.sub(feeAmount);

  const transactionHash = await transferErc20WithEstimatedGas(
    tokenContract,
    provider,
    beneficiaryAddress,
    beneficiaryAmount,
    logger
  );

  let feeTransactionHash: string | undefined;
  if (feeAmount.gt(0)) {
    feeTransactionHash = await transferErc20WithEstimatedGas(
      tokenContract,
      provider,
      kernelFeeRecipient,
      feeAmount,
      logger
    );
  }

  return { transactionHash, feeTransactionHash };
}

async function transferErc20WithEstimatedGas(
  tokenContract: ethers.Contract,
  provider: ethers.providers.Provider,
  recipient: string,
  amount: ethers.BigNumber,
  logger: Logger
): Promise<string> {
  const resolvedRecipient = utils.isAddress(recipient) ? recipient : await provider.resolveName(recipient);
  if (!resolvedRecipient) {
    const errorMessage = `Failed to resolve recipient address: ${recipient}`;
    logger.error(errorMessage);
    throw new Error(errorMessage);
  }

  const estimatedGas = await tokenContract.estimateGas.transfer(resolvedRecipient, amount);
  const gasLimit = estimatedGas.mul(120).div(100);
  const feeData = await provider.getFeeData();

  const overrides: ethers.PayableOverrides = { gasLimit };
  if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
    overrides.maxFeePerGas = feeData.maxFeePerGas;
    overrides.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
  } else if (feeData.gasPrice) {
    overrides.gasPrice = feeData.gasPrice;
  }

  const transaction = await tokenContract.transfer(resolvedRecipient, amount, overrides);
  if (typeof transaction.wait === "function") {
    await transaction.wait();
  }

  logger.info("Executed ERC20 automatic transfer", {
    recipient: resolvedRecipient,
    amount: amount.toString(),
    transactionHash: transaction.hash,
  });

  return transaction.hash;
}

async function getPrivateKey(evmPrivateEncrypted: string, logger: Logger) {
  try {
    const privateKeyDecrypted = await decrypt(evmPrivateEncrypted, String(process.env.X25519_PRIVATE_KEY));
    const privateKeyParsed = parseDecryptedPrivateKey(privateKeyDecrypted);
    const privateKey = privateKeyParsed.privateKey;
    if (!privateKey) throw new Error("Private key is not defined");
    return privateKey;
  } catch (error) {
    const errorMessage = `Failed to decrypt a private key: ${error}`;
    logger.error(errorMessage);
    throw new Error(errorMessage);
  }
}

async function getAdminWallet(privateKey: string, provider: ethers.providers.Provider, logger: Logger) {
  try {
    return new ethers.Wallet(privateKey, provider);
  } catch (error) {
    const errorMessage = `Failed to instantiate wallet: ${error}`;
    logger.debug(errorMessage);
    throw new Error(errorMessage);
  }
}

async function getTokenDecimals(tokenAddress: string, provider: ethers.providers.Provider, logger: Logger) {
  try {
    const erc20Abi = ["function decimals() public view returns (uint8)"];
    const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, provider);
    return await tokenContract.decimals();
  } catch (error) {
    const errorMessage = `Failed to get token decimals for token: ${tokenAddress}, ${error}`;
    logger.debug(errorMessage, { error });
    throw new Error(errorMessage);
  }
}
