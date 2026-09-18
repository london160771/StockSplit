use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    program_pack::Pack,
};
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use anchor_spl::{token, token_2022};
use spl_token_2022::extension::{
    default_account_state::DefaultAccountState, pausable::PausableConfig,
    transfer_hook::TransferHook, BaseStateWithExtensions, ExtensionType, StateWithExtensions,
};
use spl_token_2022::state::{AccountState, Mint as SplTokenMint};

declare_id!("9nLrXyjgLTwMxnyBJ2GnKqnHZiu5koYNHrpKXezVGDmm");

const PORTFOLIO_SEED: &[u8] = b"portfolio";
const VAULT_SEED: &[u8] = b"vault";
const MEMBER_SEED: &[u8] = b"member";

const MAX_NAME_BYTES: usize = 64;
const MAX_DESCRIPTION_BYTES: usize = 256;
const MAX_BASKET_ASSETS: usize = 8;
const MAX_ROUTE_PLAN_STEPS: usize = 64;
const TOTAL_ALLOCATION_BPS: u32 = 10_000;
const EXPECTED_TOKEN_DECIMALS: u8 = 6;
const MAX_SLIPPAGE_BPS: u16 = 1_000;
const LEG_PENDING: u8 = 0;
const LEG_COMPLETED: u8 = 1;

const JUPITER_V6_PROGRAM_ID: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const JUPITER_EVENT_AUTHORITY: Pubkey = pubkey!("D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf");
const JUPITER_ROUTE_V2_DISCRIMINATOR: [u8; 8] = [187, 100, 250, 204, 49, 196, 175, 20];
const JUPITER_SHARED_ACCOUNTS_ROUTE_V2_CURRENT_DISCRIMINATOR: [u8; 8] =
    [209, 152, 83, 147, 124, 254, 216, 233];
const JUPITER_PROGRAM_AUTHORITY: Pubkey = pubkey!("2MFoS3MPtvyQ4Wh4M9pdfPjz6UhVoNbFbGJAskCPCj3h");
#[cfg(feature = "devnet-demo")]
const DEMO_USDC_MINT: Pubkey = pubkey!("HfstGSPF1MJsD8hrpYTcPhqT6uxXTvCFSeuBYLsZJ26J");
#[cfg(feature = "devnet-demo")]
const DEMO_NVDA_MINT: Pubkey = pubkey!("Cedwf76ynoKGU5jRxHNx2Y1B2b8VNuEEuf2jDevy7L9F");
#[cfg(feature = "devnet-demo")]
const DEMO_AAPL_MINT: Pubkey = pubkey!("7DB6cCsaG1sFvPzX8DUL3GfetHbQyEMYmYHuShdhiNDW");
#[cfg(feature = "devnet-demo")]
const DEMO_TSLA_MINT: Pubkey = pubkey!("AzkzmLNh2SzTTdHnYmaC4GAxiLnngCJkPeLDCNLRbPWm");
#[cfg(feature = "devnet-demo")]
const DEMO_SPY_MINT: Pubkey = pubkey!("8DrsDuwYPsSY8LaLGKpiBFyCkz5bLFzdZAk6kbqKADJ9");
#[cfg(feature = "devnet-demo")]
const DEMO_AUTHORITY_SEED: &[u8] = b"demo-authority";

#[cfg(feature = "devnet-demo")]
fn is_approved_demo_output_mint(mint: Pubkey) -> bool {
    [
        DEMO_NVDA_MINT,
        DEMO_AAPL_MINT,
        DEMO_TSLA_MINT,
        DEMO_SPY_MINT,
    ]
    .contains(&mint)
}

const STATUS_DRAFT: u8 = 0;
const STATUS_FUNDING: u8 = 1;
const STATUS_FUNDING_CLOSED: u8 = 2;
const STATUS_DEPLOYING: u8 = 3;
const STATUS_ACTIVE: u8 = 4;
const STATUS_CLOSED: u8 = 5;
const STATUS_CANCELLED: u8 = 6;
const MEMBER_REFUNDED: u8 = 2;
const ASSOCIATED_TOKEN_PROGRAM_ID: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

fn require_initialized_token_account_state(state: AccountState) -> Result<()> {
    require!(
        state == AccountState::Initialized,
        StockSplitError::TokenAccountUnavailable
    );
    Ok(())
}

fn require_disabled_transfer_hook(program_id: Option<Pubkey>) -> Result<()> {
    require!(
        program_id.is_none(),
        StockSplitError::UnsupportedMintExtension
    );
    Ok(())
}

fn require_unpaused_mint(paused: bool) -> Result<()> {
    require!(!paused, StockSplitError::TokenMintUnavailable);
    Ok(())
}

fn require_default_account_initialized(state: u8) -> Result<()> {
    require!(
        state == AccountState::Initialized as u8,
        StockSplitError::TokenAccountUnavailable
    );
    Ok(())
}

fn validate_token_2022_mint(mint: &AccountInfo, expected_decimals: Option<u8>) -> Result<u8> {
    require_keys_eq!(
        *mint.owner,
        token_2022::ID,
        StockSplitError::Token2022Required
    );

    let mint_data = mint
        .try_borrow_data()
        .map_err(|_| error!(StockSplitError::InvalidMintAccount))?;
    let mint_state = StateWithExtensions::<SplTokenMint>::unpack(&mint_data)
        .map_err(|_| error!(StockSplitError::InvalidMintAccount))?;
    if let Some(expected_decimals) = expected_decimals {
        require!(
            mint_state.base.decimals == expected_decimals,
            StockSplitError::InvalidMintDecimals
        );
    }

    for extension in mint_state
        .get_extension_types()
        .map_err(|_| error!(StockSplitError::InvalidMintAccount))?
    {
        match extension {
            ExtensionType::MetadataPointer
            | ExtensionType::TokenMetadata
            | ExtensionType::ScaledUiAmount
            | ExtensionType::DefaultAccountState
            | ExtensionType::Pausable
            | ExtensionType::TransferHook => {}
            _ => return Err(error!(StockSplitError::UnsupportedMintExtension)),
        }
    }

    if let Ok(default_state) = mint_state.get_extension::<DefaultAccountState>() {
        require_default_account_initialized(default_state.state)?;
    }

    // A disabled transfer hook is compatible with the controlled CPI path.
    // An active hook can add arbitrary transfer-time behavior and is therefore
    // rejected until a separately reviewed hook policy exists.
    if let Ok(transfer_hook) = mint_state.get_extension::<TransferHook>() {
        require_disabled_transfer_hook(Option::<Pubkey>::from(transfer_hook.program_id))?;
    }
    Ok(mint_state.base.decimals)
}

fn require_mint_usable_for_transfer(
    mint: &AccountInfo,
    expected_decimals: Option<u8>,
) -> Result<u8> {
    let decimals = if *mint.owner == token::ID {
        validate_legacy_usdc_mint(mint)?
    } else {
        validate_token_2022_mint(mint, expected_decimals)?
    };

    if *mint.owner == token_2022::ID {
        let mint_data = mint
            .try_borrow_data()
            .map_err(|_| error!(StockSplitError::InvalidMintAccount))?;
        let mint_state = StateWithExtensions::<SplTokenMint>::unpack(&mint_data)
            .map_err(|_| error!(StockSplitError::InvalidMintAccount))?;
        if let Ok(pausable) = mint_state.get_extension::<PausableConfig>() {
            require_unpaused_mint(bool::from(pausable.paused))?;
        }
    }

    Ok(decimals)
}

fn validate_legacy_usdc_mint(mint: &AccountInfo) -> Result<u8> {
    require_keys_eq!(*mint.owner, token::ID, StockSplitError::InvalidMintAccount);
    let mint_data = mint
        .try_borrow_data()
        .map_err(|_| error!(StockSplitError::InvalidMintAccount))?;
    let mint_state = SplTokenMint::unpack(&mint_data)
        .map_err(|_| error!(StockSplitError::InvalidMintAccount))?;
    require!(
        mint_state.decimals == EXPECTED_TOKEN_DECIMALS,
        StockSplitError::InvalidMintDecimals
    );
    Ok(mint_state.decimals)
}

fn validate_usdc_mint(mint: &AccountInfo) -> Result<u8> {
    if *mint.owner == token::ID {
        validate_legacy_usdc_mint(mint)
    } else {
        // Phase 1 test portfolios use Token-2022 mock USDC. Real routed swaps
        // may use canonical legacy SPL USDC; both paths are deliberately
        // accepted, but both remain fixed at six decimals.
        validate_token_2022_mint(mint, Some(EXPECTED_TOKEN_DECIMALS))
    }
}

fn require_configured_vault_mint(portfolio: &Portfolio, mint: Pubkey) -> Result<()> {
    if portfolio.usdc_mint != Pubkey::default() {
        let is_configured =
            mint == portfolio.usdc_mint || portfolio.basket.iter().any(|asset| asset.mint == mint);
        require!(is_configured, StockSplitError::InvalidVaultMint);
    }
    Ok(())
}

fn require_usable_token_account(
    account_info: &AccountInfo,
    account: &TokenAccount,
    expected_mint: Pubkey,
    expected_owner: Pubkey,
    expected_token_program: Pubkey,
) -> Result<()> {
    require_keys_eq!(
        *account_info.owner,
        expected_token_program,
        StockSplitError::InvalidTokenAccount
    );
    require_keys_eq!(
        account.mint,
        expected_mint,
        StockSplitError::InvalidTokenAccount
    );
    require_keys_eq!(
        account.owner,
        expected_owner,
        StockSplitError::InvalidTokenAccount
    );
    require_initialized_token_account_state(account.state)
}

fn deserialize_token_account(account_info: &AccountInfo) -> Result<TokenAccount> {
    let account_data = account_info
        .try_borrow_data()
        .map_err(|_| error!(StockSplitError::InvalidTokenAccount))?;
    let mut account_data_slice: &[u8] = &account_data;
    TokenAccount::try_deserialize_unchecked(&mut account_data_slice)
        .map_err(|_| error!(StockSplitError::InvalidTokenAccount))
}

/// Returns the floor-rounded raw-token entitlement for one withdrawal.
///
/// The denominator is the current outstanding ownership total, not the
/// original contribution total. u128 arithmetic prevents a valid pair of
/// u64 balances/units from overflowing before division.
fn withdrawal_entitlement(vault_balance: u64, member_units: u64, total_units: u64) -> Result<u64> {
    require!(
        total_units > 0,
        StockSplitError::OwnershipAccountingInvariant
    );
    require!(
        member_units > 0 && member_units <= total_units,
        StockSplitError::OwnershipAccountingInvariant
    );
    let numerator = (vault_balance as u128)
        .checked_mul(member_units as u128)
        .ok_or(StockSplitError::ArithmeticOverflow)?;
    let amount = numerator
        .checked_div(total_units as u128)
        .ok_or(StockSplitError::ArithmeticOverflow)?;
    u64::try_from(amount).map_err(|_| error!(StockSplitError::ArithmeticOverflow))
}

fn deployment_input_amount(portfolio: &Portfolio, basket_index: usize) -> Result<u64> {
    require!(
        basket_index < portfolio.basket.len(),
        StockSplitError::InvalidDeploymentLeg
    );

    if basket_index == portfolio.basket.len() - 1 {
        let mut allocated_before = 0u64;
        for asset in portfolio.basket.iter().take(basket_index) {
            let amount = portfolio
                .total_contributed
                .checked_mul(asset.allocation_bps as u64)
                .ok_or(StockSplitError::ArithmeticOverflow)?
                .checked_div(TOTAL_ALLOCATION_BPS as u64)
                .ok_or(StockSplitError::ArithmeticOverflow)?;
            allocated_before = allocated_before
                .checked_add(amount)
                .ok_or(StockSplitError::ArithmeticOverflow)?;
        }
        portfolio
            .total_contributed
            .checked_sub(allocated_before)
            .ok_or(StockSplitError::ArithmeticOverflow.into())
    } else {
        portfolio
            .total_contributed
            .checked_mul(portfolio.basket[basket_index].allocation_bps as u64)
            .ok_or(StockSplitError::ArithmeticOverflow)?
            .checked_div(TOTAL_ALLOCATION_BPS as u64)
            .ok_or(StockSplitError::ArithmeticOverflow.into())
    }
}

fn require_pending_leg(leg: &DeploymentLeg) -> Result<()> {
    require!(
        leg.status == LEG_PENDING,
        StockSplitError::DeploymentAlreadyCompleted
    );
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum JupiterV2Variant {
    RouteV2,
    SharedAccountsRouteV2,
}

struct JupiterV2Args {
    variant: JupiterV2Variant,
    route_id: Option<u8>,
    in_amount: u64,
    quoted_out_amount: u64,
    slippage_bps: u16,
    platform_fee_bps: u16,
    positive_slippage_bps: u16,
}

fn take_bytes<'a>(data: &mut &'a [u8], length: usize) -> Result<&'a [u8]> {
    require!(
        data.len() >= length,
        StockSplitError::InvalidSwapInstruction
    );
    let (head, tail) = data.split_at(length);
    *data = tail;
    Ok(head)
}

fn take_u8(data: &mut &[u8]) -> Result<u8> {
    Ok(take_bytes(data, 1)?[0])
}

fn take_u16(data: &mut &[u8]) -> Result<u16> {
    Ok(u16::from_le_bytes(take_bytes(data, 2)?.try_into().unwrap()))
}

fn take_u32(data: &mut &[u8]) -> Result<u32> {
    Ok(u32::from_le_bytes(take_bytes(data, 4)?.try_into().unwrap()))
}

fn take_u64(data: &mut &[u8]) -> Result<u64> {
    Ok(u64::from_le_bytes(take_bytes(data, 8)?.try_into().unwrap()))
}

fn take_u128(data: &mut &[u8]) -> Result<u128> {
    Ok(u128::from_le_bytes(
        take_bytes(data, 16)?.try_into().unwrap(),
    ))
}

fn take_bool(data: &mut &[u8]) -> Result<()> {
    require!(take_u8(data)? <= 1, StockSplitError::InvalidSwapInstruction);
    Ok(())
}

fn take_side(data: &mut &[u8]) -> Result<()> {
    require!(take_u8(data)? <= 1, StockSplitError::InvalidSwapInstruction);
    Ok(())
}

fn take_vec_bytes(data: &mut &[u8]) -> Result<()> {
    let length = take_u32(data)? as usize;
    take_bytes(data, length)?;
    Ok(())
}

fn take_optional_remaining_accounts_none(data: &mut &[u8]) -> Result<()> {
    match take_u8(data)? {
        0 => Ok(()),
        1 => Err(error!(StockSplitError::UnsupportedRoutePlanVariant)),
        _ => Err(error!(StockSplitError::InvalidSwapInstruction)),
    }
}

fn decode_supported_swap_variant(data: &mut &[u8]) -> Result<u8> {
    let tag = take_u8(data)?;
    match tag {
        // Current Jupiter V2 generated ABI variants with no payload.
        0..=7
        | 9..=11
        | 13..=14
        | 19..=20
        | 22
        | 25..=26
        | 30..=32
        | 34..=38
        | 40
        | 46
        | 48..=57
        | 59
        | 62..=63
        | 65..=70
        | 72..=74
        | 76..=80
        | 83..=84
        | 88
        | 90..=93
        | 96..=102
        | 105
        | 109
        | 112..=115
        | 128
        | 130..=131
        | 133..=134
        | 137..=140
        | 142..=144
        | 147..=150
        | 156 => {}
        // Variants with one bool payload.
        8
        | 17..=18
        | 21
        | 23
        | 58
        | 60..=61
        | 85
        | 94..=95
        | 104
        | 106
        | 117
        | 119
        | 121
        | 127
        | 129
        | 136
        | 141
        | 145
        | 151 => take_bool(data)?,
        // Variants with a side enum payload.
        12 | 15..=16 | 24 | 27..=28 | 39 | 64 | 89 | 107 | 110 | 116 | 125 | 132 => {
            take_side(data)?
        }
        // Fixed numeric payloads.
        29 => {
            take_u64(data)?;
            take_u64(data)?;
        }
        33 | 41 => {
            take_u32(data)?;
        }
        42 => {
            take_u8(data)?;
            take_bool(data)?;
            take_bool(data)?;
        }
        43 | 135 => {
            take_u8(data)?;
            take_u8(data)?;
            take_u32(data)?;
            take_u32(data)?;
        }
        44..=45 => {
            take_u8(data)?;
            take_u32(data)?;
        }
        71 => {
            take_u8(data)?;
            take_u8(data)?;
        }
        81..=82 => {
            take_u64(data)?;
        }
        86 => {
            take_bool(data)?;
            take_u8(data)?;
        }
        87 | 118 => {
            take_u64(data)?;
            take_bool(data)?;
        }
        122 => {
            take_u128(data)?;
        }
        123 => {
            for _ in 0..5 {
                take_u64(data)?;
            }
            take_u64(data)?;
        }
        126 => {
            take_side(data)?;
            take_u64(data)?;
            take_u64(data)?;
        }
        // Jupiter RFQ is not returned by /build, but its V2 payload is still
        // decoded here so malformed bytes cannot be mistaken for trailing data.
        120 => {
            take_side(data)?;
            take_vec_bytes(data)?;
        }
        // WhirlpoolSwapV2 (the currently observed variant 0x2f) carries an
        // a_to_b boolean followed by an optional RemainingAccountsInfo. The
        // first live proof intentionally supports only the canonical None
        // form; Some would need an explicit accounts-slice policy.
        47 => {
            take_bool(data)?;
            take_optional_remaining_accounts_none(data)?;
        }
        // These variants carry nested account-slice/candidate data whose ABI
        // is not part of the supported /build proof. Reject them explicitly.
        75 | 103 | 111 | 146 => {
            return Err(error!(StockSplitError::UnsupportedRoutePlanVariant));
        }
        _ => return Err(error!(StockSplitError::UnsupportedRoutePlanVariant)),
    }
    Ok(tag)
}

fn decode_jupiter_v2(swap_data: &[u8]) -> Result<JupiterV2Args> {
    require!(
        swap_data.len() >= 8,
        StockSplitError::InvalidSwapInstruction
    );
    let discriminator: [u8; 8] = swap_data[..8].try_into().unwrap();
    let variant = if discriminator == JUPITER_ROUTE_V2_DISCRIMINATOR {
        JupiterV2Variant::RouteV2
    } else if discriminator == JUPITER_SHARED_ACCOUNTS_ROUTE_V2_CURRENT_DISCRIMINATOR {
        JupiterV2Variant::SharedAccountsRouteV2
    } else {
        return Err(error!(StockSplitError::InvalidSwapInstruction));
    };

    let mut data = &swap_data[8..];
    let route_id = if variant == JupiterV2Variant::SharedAccountsRouteV2 {
        // Both the current discriminator and the pinned legacy V2
        // discriminator retain the one-byte route id before the common
        // exact-in arguments.
        Some(take_u8(&mut data)?)
    } else {
        None
    };
    let in_amount = take_u64(&mut data)?;
    let quoted_out_amount = take_u64(&mut data)?;
    let slippage_bps = take_u16(&mut data)?;
    let platform_fee_bps = take_u16(&mut data)?;
    let positive_slippage_bps = take_u16(&mut data)?;
    let route_plan_len = take_u32(&mut data)? as usize;
    require!(
        route_plan_len > 0 && route_plan_len <= MAX_ROUTE_PLAN_STEPS,
        StockSplitError::InvalidSwapInstruction
    );

    for _ in 0..route_plan_len {
        decode_supported_swap_variant(&mut data)?;
        let bps = take_u16(&mut data)?;
        require!(
            bps > 0 && bps <= TOTAL_ALLOCATION_BPS as u16,
            StockSplitError::InvalidSwapInstruction
        );
        take_u8(&mut data)?;
        take_u8(&mut data)?;
    }
    require!(data.is_empty(), StockSplitError::InvalidSwapInstruction);

    Ok(JupiterV2Args {
        variant,
        route_id,
        in_amount,
        quoted_out_amount,
        slippage_bps,
        platform_fee_bps,
        positive_slippage_bps,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DynamicRouteAccount {
    key: Pubkey,
    is_signer: bool,
}

fn validate_dynamic_route_account(account: DynamicRouteAccount) -> Result<()> {
    require!(!account.is_signer, StockSplitError::InvalidSwapAccounts);

    // Duplicate privileges are merged by Solana before this program receives
    // AccountInfo values. The named portfolio/vault accounts are writable, so
    // a repeated route occurrence cannot reliably report Jupiter's original
    // writability here. Pubkey binding and the outer signer prohibition remain
    // authoritative; intended inner privileges are rebuilt below.
    require!(
        account.key != Pubkey::default(),
        StockSplitError::InvalidSwapAccounts
    );

    Ok(())
}

fn build_jupiter_cpi_meta(
    index: usize,
    account: &AccountInfo,
    authority_index: usize,
    portfolio: Pubkey,
    usdc_vault: Pubkey,
    output_vault: Pubkey,
) -> AccountMeta {
    if index == authority_index {
        // The portfolio PDA is the only signer restored for the inner CPI,
        // and its authority metadata is always read-only inside Jupiter.
        return AccountMeta::new_readonly(*account.key, true);
    }

    if *account.key == portfolio {
        return AccountMeta::new_readonly(*account.key, false);
    }

    if *account.key == usdc_vault || *account.key == output_vault {
        return AccountMeta::new(*account.key, false);
    }

    if account.is_writable {
        AccountMeta::new(*account.key, false)
    } else {
        AccountMeta::new_readonly(*account.key, false)
    }
}

fn validate_jupiter_v2_accounts(
    args: &JupiterV2Args,
    route_accounts: &[AccountInfo],
    portfolio: Pubkey,
    usdc_vault: Pubkey,
    output_vault: Pubkey,
    input_mint: Pubkey,
    output_mint: Pubkey,
    input_token_program: Pubkey,
    output_token_program: Pubkey,
    jupiter_program: Pubkey,
) -> Result<usize> {
    let fixed_count = match args.variant {
        JupiterV2Variant::RouteV2 => 10,
        JupiterV2Variant::SharedAccountsRouteV2 => 12,
    };
    require!(
        route_accounts.len() >= fixed_count,
        StockSplitError::InvalidSwapAccounts
    );
    if args.variant == JupiterV2Variant::SharedAccountsRouteV2 {
        require!(
            args.route_id.is_some(),
            StockSplitError::InvalidSwapInstruction
        );
    }

    for account in route_accounts.iter() {
        // The only signer privilege this program may add is the portfolio PDA
        // at the variant-specific user transfer authority position below
        // (RouteV2 index 0; SharedAccountsRouteV2 index 1). Dynamic accounts
        // are never signers.
        require!(!account.is_signer, StockSplitError::InvalidSwapAccounts);
    }

    match args.variant {
        JupiterV2Variant::RouteV2 => {
            require_keys_eq!(
                route_accounts[0].key(),
                portfolio,
                StockSplitError::InvalidSwapAuthority
            );
            require_keys_eq!(
                route_accounts[1].key(),
                usdc_vault,
                StockSplitError::InvalidSwapSource
            );
            require_keys_eq!(
                route_accounts[2].key(),
                output_vault,
                StockSplitError::InvalidSwapDestination
            );
            require!(
                route_accounts[1].is_writable && route_accounts[2].is_writable,
                StockSplitError::InvalidSwapAccounts
            );
            require_keys_eq!(
                route_accounts[3].key(),
                input_mint,
                StockSplitError::InvalidSwapMint
            );
            require_keys_eq!(
                route_accounts[4].key(),
                output_mint,
                StockSplitError::InvalidSwapMint
            );
            require_keys_eq!(
                route_accounts[5].key(),
                input_token_program,
                StockSplitError::InvalidSwapAccounts
            );
            require_keys_eq!(
                route_accounts[6].key(),
                output_token_program,
                StockSplitError::InvalidSwapAccounts
            );
            require!(
                route_accounts[7].key() == output_vault
                    || route_accounts[7].key() == JUPITER_V6_PROGRAM_ID,
                StockSplitError::InvalidSwapDestination
            );
            if route_accounts[7].key() == output_vault {
                require!(
                    route_accounts[7].is_writable,
                    StockSplitError::InvalidSwapAccounts
                );
            } else {
                require!(
                    !route_accounts[7].is_writable,
                    StockSplitError::InvalidSwapAccounts
                );
            }
            require_keys_eq!(
                route_accounts[8].key(),
                JUPITER_EVENT_AUTHORITY,
                StockSplitError::InvalidSwapAccounts
            );
            require_keys_eq!(
                route_accounts[9].key(),
                jupiter_program,
                StockSplitError::UnsupportedSwapProgram
            );
            require!(
                !route_accounts[8].is_writable && !route_accounts[9].is_writable,
                StockSplitError::InvalidSwapAccounts
            );
        }
        JupiterV2Variant::SharedAccountsRouteV2 => {
            require_keys_eq!(
                route_accounts[0].key(),
                JUPITER_PROGRAM_AUTHORITY,
                StockSplitError::InvalidSwapAuthority
            );
            require!(
                !route_accounts[0].is_writable,
                StockSplitError::InvalidSwapAccounts
            );
            require!(
                route_accounts[0].key() != Pubkey::default(),
                StockSplitError::InvalidSwapAuthority
            );
            require_keys_eq!(
                route_accounts[1].key(),
                portfolio,
                StockSplitError::InvalidSwapAuthority
            );
            require_keys_eq!(
                route_accounts[2].key(),
                usdc_vault,
                StockSplitError::InvalidSwapSource
            );
            require_keys_eq!(
                route_accounts[5].key(),
                output_vault,
                StockSplitError::InvalidSwapDestination
            );
            require!(
                route_accounts[2].is_writable
                    && route_accounts[3].is_writable
                    && route_accounts[4].is_writable
                    && route_accounts[5].is_writable,
                StockSplitError::InvalidSwapAccounts
            );
            require_keys_eq!(
                route_accounts[6].key(),
                input_mint,
                StockSplitError::InvalidSwapMint
            );
            require_keys_eq!(
                route_accounts[7].key(),
                output_mint,
                StockSplitError::InvalidSwapMint
            );
            require_keys_eq!(
                route_accounts[8].key(),
                input_token_program,
                StockSplitError::InvalidSwapAccounts
            );
            require_keys_eq!(
                route_accounts[9].key(),
                output_token_program,
                StockSplitError::InvalidSwapAccounts
            );
            require_keys_eq!(
                route_accounts[10].key(),
                JUPITER_EVENT_AUTHORITY,
                StockSplitError::InvalidSwapAccounts
            );
            require_keys_eq!(
                route_accounts[11].key(),
                jupiter_program,
                StockSplitError::UnsupportedSwapProgram
            );
            require!(
                !route_accounts[10].is_writable && !route_accounts[11].is_writable,
                StockSplitError::InvalidSwapAccounts
            );
        }
    }

    for account in route_accounts.iter().skip(fixed_count) {
        validate_dynamic_route_account(DynamicRouteAccount {
            key: account.key(),
            is_signer: account.is_signer,
        })?;
    }

    Ok(match args.variant {
        JupiterV2Variant::RouteV2 => 0,
        JupiterV2Variant::SharedAccountsRouteV2 => 1,
    })
}

#[program]
pub mod stock_split_phase0 {
    use super::*;

    /// Creates the Phase 0 portfolio PDA used as the authority for every vault.
    ///
    /// This is intentionally not the Phase 1 portfolio lifecycle instruction.
    /// It only establishes the deterministic PDA authority needed to prove
    /// custody before funding and ownership state are introduced.
    pub fn initialize_portfolio(
        ctx: Context<InitializePortfolio>,
        portfolio_id: u64,
    ) -> Result<()> {
        let portfolio = &mut ctx.accounts.portfolio;
        portfolio.creator = ctx.accounts.creator.key();
        portfolio.portfolio_id = portfolio_id;
        portfolio.bump = ctx.bumps.portfolio;
        portfolio.status = STATUS_DRAFT;
        portfolio.funding_start = 0;
        portfolio.funding_deadline = 0;
        portfolio.target_usdc = 0;
        portfolio.usdc_mint = Pubkey::default();
        portfolio.total_units = 0;
        portfolio.total_contributed = 0;
        portfolio.basket_locked = false;
        portfolio.ownership_locked = false;
        portfolio.funding_closed_at = 0;
        portfolio.name = String::new();
        portfolio.description = String::new();
        portfolio.basket = Vec::new();
        portfolio.deployment_legs = Vec::new();
        portfolio.phase2_reserved = Vec::new();
        Ok(())
    }

    /// Creates a complete invite-only Phase 1 portfolio in DRAFT state.
    pub fn create_portfolio(
        ctx: Context<CreatePortfolio>,
        portfolio_id: u64,
        name: String,
        description: String,
        funding_start: i64,
        funding_deadline: i64,
        target_usdc: u64,
        basket: Vec<BasketAsset>,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            *ctx.accounts.usdc_mint.to_account_info().owner,
            StockSplitError::InvalidUsdcMint
        );
        validate_usdc_mint(&ctx.accounts.usdc_mint.to_account_info())?;
        require!(
            name.as_bytes().len() <= MAX_NAME_BYTES,
            StockSplitError::MetadataTooLong
        );
        require!(
            description.as_bytes().len() <= MAX_DESCRIPTION_BYTES,
            StockSplitError::MetadataTooLong
        );
        require!(
            funding_start < funding_deadline,
            StockSplitError::InvalidFundingWindow
        );
        require!(
            funding_deadline > Clock::get()?.unix_timestamp,
            StockSplitError::FundingWindowExpired
        );
        require!(target_usdc > 0, StockSplitError::InvalidTarget);
        require!(
            !basket.is_empty() && basket.len() <= MAX_BASKET_ASSETS,
            StockSplitError::InvalidBasket
        );
        require!(
            ctx.remaining_accounts.len() == basket.len(),
            StockSplitError::InvalidBasketMint
        );

        let mut allocation_total = 0u32;
        for (index, asset) in basket.iter().enumerate() {
            require!(
                asset.mint != ctx.accounts.usdc_mint.key(),
                StockSplitError::InvalidBasket
            );
            let basket_mint = &ctx.remaining_accounts[index];
            require_keys_eq!(
                basket_mint.key(),
                asset.mint,
                StockSplitError::InvalidBasketMint
            );
            validate_token_2022_mint(basket_mint, None)?;
            allocation_total = allocation_total
                .checked_add(asset.allocation_bps as u32)
                .ok_or(StockSplitError::ArithmeticOverflow)?;

            for previous in basket.iter().take(index) {
                require!(
                    asset.mint != previous.mint,
                    StockSplitError::DuplicateBasketAsset
                );
            }
        }
        require!(
            allocation_total == TOTAL_ALLOCATION_BPS,
            StockSplitError::InvalidAllocation
        );

        let portfolio = &mut ctx.accounts.portfolio;
        portfolio.creator = ctx.accounts.creator.key();
        portfolio.portfolio_id = portfolio_id;
        portfolio.bump = ctx.bumps.portfolio;
        portfolio.status = STATUS_DRAFT;
        portfolio.funding_start = funding_start;
        portfolio.funding_deadline = funding_deadline;
        portfolio.target_usdc = target_usdc;
        portfolio.usdc_mint = ctx.accounts.usdc_mint.key();
        portfolio.total_units = 0;
        portfolio.total_contributed = 0;
        portfolio.basket_locked = true;
        portfolio.ownership_locked = false;
        portfolio.funding_closed_at = 0;
        portfolio.name = name;
        portfolio.description = description;
        portfolio.basket = basket;
        portfolio.deployment_legs = portfolio
            .basket
            .iter()
            .map(|asset| DeploymentLeg {
                mint: asset.mint,
                allocation_bps: asset.allocation_bps,
                status: LEG_PENDING,
                input_amount: 0,
                output_amount: 0,
            })
            .collect();
        portfolio.phase2_reserved = Vec::new();
        Ok(())
    }

    /// Opens the configured contribution window.
    pub fn open_funding(ctx: Context<CreatorPortfolio>) -> Result<()> {
        let portfolio = &mut ctx.accounts.portfolio;
        require!(
            portfolio.status == STATUS_DRAFT,
            StockSplitError::InvalidLifecycle
        );

        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= portfolio.funding_start,
            StockSplitError::FundingNotOpen
        );
        require!(
            now < portfolio.funding_deadline,
            StockSplitError::FundingWindowExpired
        );

        portfolio.status = STATUS_FUNDING;
        Ok(())
    }

    /// Adds a wallet to the invite-only member set before funding closes.
    pub fn invite_member(ctx: Context<InviteMember>) -> Result<()> {
        let portfolio = &ctx.accounts.portfolio;
        require!(
            portfolio.status == STATUS_DRAFT || portfolio.status == STATUS_FUNDING,
            StockSplitError::InvalidLifecycle
        );
        require!(
            ctx.accounts.wallet.key() != Pubkey::default(),
            StockSplitError::InvalidMember
        );
        require!(
            Clock::get()?.unix_timestamp < portfolio.funding_deadline,
            StockSplitError::FundingWindowExpired
        );

        let member = &mut ctx.accounts.member;
        member.portfolio = portfolio.key();
        member.wallet = ctx.accounts.wallet.key();
        member.bump = ctx.bumps.member;
        member.total_contributed = 0;
        member.ownership_units = 0;
        member.withdrawal_status = 0;
        member.phase2_reserved = Vec::new();
        Ok(())
    }

    /// Moves Token-2022 USDC into the portfolio vault and issues matching units.
    pub fn contribute(ctx: Context<Contribute>, amount: u64) -> Result<()> {
        let portfolio = &mut ctx.accounts.portfolio;
        require!(
            portfolio.status == STATUS_FUNDING,
            StockSplitError::InvalidLifecycle
        );
        require!(!portfolio.ownership_locked, StockSplitError::FundingClosed);
        require!(amount > 0, StockSplitError::AmountMustBePositive);

        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= portfolio.funding_start,
            StockSplitError::FundingNotOpen
        );
        require!(
            now < portfolio.funding_deadline,
            StockSplitError::FundingWindowExpired
        );
        require!(
            portfolio.total_units == portfolio.total_contributed,
            StockSplitError::OwnershipAccountingInvariant
        );

        let mint_info = ctx.accounts.mint.to_account_info();
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            *mint_info.owner,
            StockSplitError::InvalidUsdcMint
        );
        validate_usdc_mint(&mint_info)?;

        let new_total_contributed = portfolio
            .total_contributed
            .checked_add(amount)
            .ok_or(StockSplitError::ArithmeticOverflow)?;
        let new_total_units = portfolio
            .total_units
            .checked_add(amount)
            .ok_or(StockSplitError::ArithmeticOverflow)?;
        require!(
            new_total_contributed <= portfolio.target_usdc,
            StockSplitError::TargetExceeded
        );
        require!(
            new_total_units <= portfolio.target_usdc,
            StockSplitError::TargetExceeded
        );
        require!(
            new_total_contributed == new_total_units,
            StockSplitError::OwnershipAccountingInvariant
        );

        let member = &mut ctx.accounts.member;
        let new_member_contribution = member
            .total_contributed
            .checked_add(amount)
            .ok_or(StockSplitError::ArithmeticOverflow)?;
        let new_member_units = member
            .ownership_units
            .checked_add(amount)
            .ok_or(StockSplitError::ArithmeticOverflow)?;

        let transfer_accounts = TransferChecked {
            from: ctx.accounts.source_token.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.contributor.to_account_info(),
        };
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            transfer_accounts,
        );
        let vault_balance_before = ctx.accounts.vault.amount;
        token_interface::transfer_checked(transfer_ctx, amount, ctx.accounts.mint.decimals)?;
        ctx.accounts.vault.reload()?;
        let actual_received = ctx
            .accounts
            .vault
            .amount
            .checked_sub(vault_balance_before)
            .ok_or(StockSplitError::VaultBalanceDecreased)?;
        require!(
            actual_received == amount,
            StockSplitError::ContributionAmountMismatch
        );

        member.total_contributed = new_member_contribution;
        member.ownership_units = new_member_units;
        portfolio.total_contributed = new_total_contributed;
        portfolio.total_units = new_total_units;
        Ok(())
    }

    /// Freezes contributions and ownership units for the deployment phase.
    pub fn close_funding(ctx: Context<CreatorPortfolio>) -> Result<()> {
        let portfolio = &mut ctx.accounts.portfolio;
        require!(
            portfolio.status == STATUS_FUNDING,
            StockSplitError::InvalidLifecycle
        );
        require!(portfolio.total_units > 0, StockSplitError::ZeroFundedClose);

        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= portfolio.funding_deadline
                || portfolio.total_contributed >= portfolio.target_usdc,
            StockSplitError::FundingNotReadyToClose
        );

        portfolio.status = STATUS_FUNDING_CLOSED;
        portfolio.ownership_locked = true;
        portfolio.funding_closed_at = now;
        Ok(())
    }

    /// Terminates an undeployed Phase 1 portfolio. Contributors then reclaim
    /// their own recorded USDC without creator involvement.
    pub fn cancel_portfolio(ctx: Context<CreatorPortfolio>) -> Result<()> {
        let portfolio = &mut ctx.accounts.portfolio;
        require!(
            portfolio.usdc_mint != Pubkey::default(),
            StockSplitError::LegacyEntrypointDisabled
        );
        require!(
            portfolio
                .deployment_legs
                .iter()
                .all(|leg| leg.status == LEG_PENDING),
            StockSplitError::DeploymentAlreadyStarted
        );
        require!(
            portfolio.status == STATUS_DRAFT
                || portfolio.status == STATUS_FUNDING
                || portfolio.status == STATUS_FUNDING_CLOSED,
            StockSplitError::InvalidLifecycle
        );
        portfolio.status = STATUS_CANCELLED;
        portfolio.ownership_locked = true;
        Ok(())
    }

    /// Returns one member's exact recorded raw USDC contribution from the
    /// canonical portfolio vault to that member's canonical USDC ATA.
    pub fn refund_member(ctx: Context<RefundMember>) -> Result<()> {
        let portfolio = &mut ctx.accounts.portfolio;
        require!(
            portfolio.status == STATUS_CANCELLED,
            StockSplitError::InvalidLifecycle
        );
        let member = &mut ctx.accounts.member;
        require!(
            member.withdrawal_status != MEMBER_REFUNDED,
            StockSplitError::RefundAlreadyCompleted
        );
        require!(
            member.withdrawal_status == 0,
            StockSplitError::InvalidRefundState
        );
        let amount = member.total_contributed;
        require!(amount > 0, StockSplitError::NoRefundAvailable);
        require!(
            member.ownership_units == amount
                && portfolio.total_units == portfolio.total_contributed
                && portfolio.total_units >= amount,
            StockSplitError::OwnershipAccountingInvariant
        );

        let mint_info = ctx.accounts.usdc_mint.to_account_info();
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            *mint_info.owner,
            StockSplitError::InvalidUsdcMint
        );
        require_mint_usable_for_transfer(&mint_info, Some(EXPECTED_TOKEN_DECIMALS))?;
        let member_wallet_key = ctx.accounts.member_wallet.key();
        let token_program_key = ctx.accounts.token_program.key();
        let usdc_mint_key = ctx.accounts.usdc_mint.key();
        let (expected_destination, _) = Pubkey::find_program_address(
            &[
                member_wallet_key.as_ref(),
                token_program_key.as_ref(),
                usdc_mint_key.as_ref(),
            ],
            &ASSOCIATED_TOKEN_PROGRAM_ID,
        );
        require_keys_eq!(
            ctx.accounts.destination_token.key(),
            expected_destination,
            StockSplitError::InvalidRefundDestination
        );
        require_usable_token_account(
            &ctx.accounts.usdc_vault.to_account_info(),
            &ctx.accounts.usdc_vault,
            ctx.accounts.usdc_mint.key(),
            portfolio.key(),
            ctx.accounts.token_program.key(),
        )?;
        require_usable_token_account(
            &ctx.accounts.destination_token.to_account_info(),
            &ctx.accounts.destination_token,
            ctx.accounts.usdc_mint.key(),
            ctx.accounts.member_wallet.key(),
            ctx.accounts.token_program.key(),
        )?;
        require!(
            ctx.accounts.usdc_vault.amount >= amount,
            StockSplitError::InsufficientRefundVaultBalance
        );

        let vault_before = ctx.accounts.usdc_vault.amount;
        let destination_before = ctx.accounts.destination_token.amount;
        let portfolio_id_bytes = portfolio.portfolio_id.to_le_bytes();
        let portfolio_bump = [portfolio.bump];
        let signer_seed_parts: &[&[u8]] = &[
            PORTFOLIO_SEED,
            portfolio.creator.as_ref(),
            portfolio_id_bytes.as_ref(),
            &portfolio_bump,
        ];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.usdc_vault.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.destination_token.to_account_info(),
                    authority: portfolio.to_account_info(),
                },
                &[signer_seed_parts],
            ),
            amount,
            EXPECTED_TOKEN_DECIMALS,
        )?;
        ctx.accounts.usdc_vault.reload()?;
        ctx.accounts.destination_token.reload()?;
        require!(
            vault_before.checked_sub(ctx.accounts.usdc_vault.amount) == Some(amount)
                && ctx
                    .accounts
                    .destination_token
                    .amount
                    .checked_sub(destination_before)
                    == Some(amount),
            StockSplitError::RefundAmountMismatch
        );

        portfolio.total_contributed = portfolio
            .total_contributed
            .checked_sub(amount)
            .ok_or(StockSplitError::OwnershipAccountingInvariant)?;
        portfolio.total_units = portfolio
            .total_units
            .checked_sub(amount)
            .ok_or(StockSplitError::OwnershipAccountingInvariant)?;
        member.total_contributed = 0;
        member.ownership_units = 0;
        member.withdrawal_status = MEMBER_REFUNDED;
        Ok(())
    }

    /// Executes exactly one fixed-allocation Jupiter/Metis route leg.
    ///
    /// The route instruction is built off-chain from Jupiter's Swap API V2
    /// and invoked here as a CPI. The program controls the only user authority
    /// accepted by the route: the portfolio PDA. A failed CPI or post-CPI
    /// invariant leaves the leg pending because the transaction is atomic.
    pub fn deploy_leg<'info>(
        ctx: Context<'_, '_, '_, 'info, DeployLeg<'info>>,
        basket_index: u8,
        expected_input_amount: u64,
        quoted_output_amount: u64,
        min_output_amount: u64,
        slippage_bps: u16,
        swap_data: Vec<u8>,
    ) -> Result<()> {
        let portfolio = &mut ctx.accounts.portfolio;
        require!(
            portfolio.status == STATUS_FUNDING_CLOSED || portfolio.status == STATUS_DEPLOYING,
            StockSplitError::InvalidLifecycle
        );
        require!(
            portfolio.total_units == portfolio.total_contributed,
            StockSplitError::OwnershipAccountingInvariant
        );
        require!(
            portfolio.deployment_legs.len() == portfolio.basket.len(),
            StockSplitError::DeploymentStateInvalid
        );

        let index = basket_index as usize;
        require!(
            index < portfolio.deployment_legs.len(),
            StockSplitError::InvalidDeploymentLeg
        );
        require_pending_leg(&portfolio.deployment_legs[index])?;

        let basket_asset = portfolio.basket[index].clone();
        require_keys_eq!(
            portfolio.deployment_legs[index].mint,
            basket_asset.mint,
            StockSplitError::DeploymentStateInvalid
        );
        require_keys_eq!(
            ctx.accounts.output_mint.key(),
            basket_asset.mint,
            StockSplitError::InvalidSwapMint
        );

        require!(
            portfolio.deployment_legs[index].allocation_bps == basket_asset.allocation_bps,
            StockSplitError::DeploymentStateInvalid
        );
        let intended_input_amount = deployment_input_amount(portfolio, index)?;

        // A zero-allocation leg is a real, deterministic completion. It must
        // not require a Jupiter instruction or a token-account lookup.
        if intended_input_amount == 0 {
            require!(
                expected_input_amount == 0
                    && quoted_output_amount == 0
                    && min_output_amount == 0
                    && slippage_bps == 0,
                StockSplitError::InvalidDeploymentAmount
            );
            let leg = &mut portfolio.deployment_legs[index];
            leg.status = LEG_COMPLETED;
            leg.input_amount = 0;
            leg.output_amount = 0;
            portfolio.status = STATUS_DEPLOYING;
            if portfolio
                .deployment_legs
                .iter()
                .all(|deployment_leg| deployment_leg.status == LEG_COMPLETED)
            {
                portfolio.status = STATUS_ACTIVE;
            }
            return Ok(());
        }
        require!(
            expected_input_amount == intended_input_amount,
            StockSplitError::InvalidDeploymentAmount
        );
        require!(
            slippage_bps <= MAX_SLIPPAGE_BPS,
            StockSplitError::SlippageTooHigh
        );
        require!(
            quoted_output_amount > 0 && min_output_amount > 0,
            StockSplitError::InvalidSlippageBounds
        );
        require!(
            min_output_amount <= quoted_output_amount,
            StockSplitError::InvalidSlippageBounds
        );
        let slippage_floor = quoted_output_amount
            .checked_mul((10_000u16 - slippage_bps) as u64)
            .ok_or(StockSplitError::ArithmeticOverflow)?
            .checked_add((TOTAL_ALLOCATION_BPS - 1) as u64)
            .ok_or(StockSplitError::ArithmeticOverflow)?
            .checked_div(TOTAL_ALLOCATION_BPS as u64)
            .ok_or(StockSplitError::ArithmeticOverflow)?;
        require!(
            min_output_amount >= slippage_floor,
            StockSplitError::InvalidSlippageBounds
        );

        require_keys_eq!(
            ctx.accounts.token_program.key(),
            *ctx.accounts.input_mint.to_account_info().owner,
            StockSplitError::InvalidUsdcMint
        );
        require_keys_eq!(
            *ctx.accounts.output_mint.to_account_info().owner,
            token_2022::ID,
            StockSplitError::Token2022Required
        );
        require_keys_eq!(
            ctx.accounts.output_token_program.key(),
            token_2022::ID,
            StockSplitError::Token2022Required
        );
        validate_usdc_mint(&ctx.accounts.input_mint.to_account_info())?;
        require_mint_usable_for_transfer(
            &ctx.accounts.input_mint.to_account_info(),
            Some(EXPECTED_TOKEN_DECIMALS),
        )?;
        require_mint_usable_for_transfer(&ctx.accounts.output_mint.to_account_info(), None)?;
        require_usable_token_account(
            &ctx.accounts.usdc_vault.to_account_info(),
            &ctx.accounts.usdc_vault,
            ctx.accounts.input_mint.key(),
            portfolio.key(),
            ctx.accounts.token_program.key(),
        )?;
        require_usable_token_account(
            &ctx.accounts.output_vault.to_account_info(),
            &ctx.accounts.output_vault,
            ctx.accounts.output_mint.key(),
            portfolio.key(),
            ctx.accounts.output_token_program.key(),
        )?;
        require!(
            ctx.accounts.usdc_vault.amount >= intended_input_amount,
            StockSplitError::InsufficientRecordedUsdc
        );
        let route_args = decode_jupiter_v2(&swap_data)?;
        require!(
            route_args.in_amount == expected_input_amount,
            StockSplitError::InvalidDeploymentAmount
        );
        require!(
            route_args.quoted_out_amount == quoted_output_amount,
            StockSplitError::InvalidSlippageBounds
        );
        require!(
            route_args.slippage_bps == slippage_bps,
            StockSplitError::InvalidSlippageBounds
        );
        require!(
            route_args.platform_fee_bps == 0 && route_args.positive_slippage_bps == 0,
            StockSplitError::UnsupportedSwapFee
        );
        let authority_index = validate_jupiter_v2_accounts(
            &route_args,
            ctx.remaining_accounts,
            portfolio.key(),
            ctx.accounts.usdc_vault.key(),
            ctx.accounts.output_vault.key(),
            ctx.accounts.input_mint.key(),
            ctx.accounts.output_mint.key(),
            ctx.accounts.token_program.key(),
            ctx.accounts.output_token_program.key(),
            ctx.accounts.jupiter_program.key(),
        )?;

        // No other configured portfolio vault may be supplied as a writable
        // route account. This prevents a route from spending another basket leg.
        let fixed_account_count = match route_args.variant {
            JupiterV2Variant::RouteV2 => 10,
            JupiterV2Variant::SharedAccountsRouteV2 => 12,
        };
        for asset in portfolio.basket.iter() {
            let (configured_vault, _) = Pubkey::find_program_address(
                &[VAULT_SEED, portfolio.key().as_ref(), asset.mint.as_ref()],
                &crate::ID,
            );
            if configured_vault == ctx.accounts.output_vault.key() {
                continue;
            }
            for account in ctx.remaining_accounts.iter().skip(fixed_account_count) {
                require!(
                    account.key() != configured_vault,
                    StockSplitError::InvalidSwapAccounts
                );
            }
        }

        let input_balance_before = ctx.accounts.usdc_vault.amount;
        let output_balance_before = ctx.accounts.output_vault.amount;
        let route_metas = ctx
            .remaining_accounts
            .iter()
            .enumerate()
            .map(|(index, account)| {
                build_jupiter_cpi_meta(
                    index,
                    account,
                    authority_index,
                    portfolio.key(),
                    ctx.accounts.usdc_vault.key(),
                    ctx.accounts.output_vault.key(),
                )
            })
            .collect::<Vec<_>>();
        let route_instruction = Instruction {
            program_id: JUPITER_V6_PROGRAM_ID,
            accounts: route_metas,
            data: swap_data,
        };

        // Revalidate mint usability and vault state at the CPI boundary. This
        // is intentionally repeated after all route checks so pausing/freezing
        // cannot be bypassed by a stale preflight observation.
        require_mint_usable_for_transfer(
            &ctx.accounts.input_mint.to_account_info(),
            Some(EXPECTED_TOKEN_DECIMALS),
        )?;
        require_mint_usable_for_transfer(&ctx.accounts.output_mint.to_account_info(), None)?;
        require_usable_token_account(
            &ctx.accounts.usdc_vault.to_account_info(),
            &ctx.accounts.usdc_vault,
            ctx.accounts.input_mint.key(),
            portfolio.key(),
            ctx.accounts.token_program.key(),
        )?;
        require_usable_token_account(
            &ctx.accounts.output_vault.to_account_info(),
            &ctx.accounts.output_vault,
            ctx.accounts.output_mint.key(),
            portfolio.key(),
            ctx.accounts.output_token_program.key(),
        )?;

        let portfolio_id_bytes = portfolio.portfolio_id.to_le_bytes();
        let portfolio_bump = [portfolio.bump];
        let signer_seed_parts: &[&[u8]] = &[
            PORTFOLIO_SEED,
            portfolio.creator.as_ref(),
            portfolio_id_bytes.as_ref(),
            &portfolio_bump,
        ];
        let signer_seeds: &[&[&[u8]]] = &[signer_seed_parts];
        let mut invoke_accounts = Vec::with_capacity(ctx.remaining_accounts.len() + 1);
        invoke_accounts.push(ctx.accounts.jupiter_program.to_account_info());
        invoke_accounts.extend(ctx.remaining_accounts.iter().cloned());
        invoke_signed(&route_instruction, &invoke_accounts, signer_seeds)
            .map_err(|_| error!(StockSplitError::JupiterSwapFailed))?;

        ctx.accounts.usdc_vault.reload()?;
        ctx.accounts.output_vault.reload()?;
        let input_spent = input_balance_before
            .checked_sub(ctx.accounts.usdc_vault.amount)
            .ok_or(StockSplitError::InputBalanceIncreased)?;
        let output_received = ctx
            .accounts
            .output_vault
            .amount
            .checked_sub(output_balance_before)
            .ok_or(StockSplitError::OutputBalanceDecreased)?;
        require!(
            input_spent == intended_input_amount,
            StockSplitError::InvalidExecutedInputAmount
        );
        require!(
            output_received >= min_output_amount,
            StockSplitError::SlippageExceeded
        );

        let leg = &mut portfolio.deployment_legs[index];
        leg.status = LEG_COMPLETED;
        leg.input_amount = input_spent;
        leg.output_amount = output_received;
        portfolio.status = STATUS_DEPLOYING;
        if portfolio
            .deployment_legs
            .iter()
            .all(|deployment_leg| deployment_leg.status == LEG_COMPLETED)
        {
            portfolio.status = STATUS_ACTIVE;
        }
        Ok(())
    }

    /// Devnet build only. Settles a fixed 1:1 raw-unit mock trade against
    /// pre-funded, PDA-owned liquidity for one of four curated mock mints. Production builds omit
    /// this instruction entirely; Jupiter deploy_leg is unchanged.
    #[cfg(feature = "devnet-demo")]
    pub fn prepare_demo_router(ctx: Context<PrepareDemoRouter>) -> Result<()> {
        require_mint_usable_for_transfer(&ctx.accounts.input_mint.to_account_info(), Some(6))?;
        require_mint_usable_for_transfer(&ctx.accounts.output_mint.to_account_info(), Some(6))?;
        Ok(())
    }

    #[cfg(feature = "devnet-demo")]
    pub fn deploy_demo_leg(
        ctx: Context<DeployDemoLeg>,
        basket_index: u8,
        expected_input_amount: u64,
        min_output_amount: u64,
    ) -> Result<()> {
        let portfolio = &mut ctx.accounts.portfolio;
        require!(
            portfolio.total_units == portfolio.total_contributed,
            StockSplitError::OwnershipAccountingInvariant
        );
        require!(
            portfolio.deployment_legs.len() == portfolio.basket.len(),
            StockSplitError::DeploymentStateInvalid
        );
        let index = basket_index as usize;
        require!(
            index < portfolio.basket.len(),
            StockSplitError::InvalidDeploymentLeg
        );
        require_pending_leg(&portfolio.deployment_legs[index])?;
        require!(
            portfolio.status == STATUS_FUNDING_CLOSED || portfolio.status == STATUS_DEPLOYING,
            StockSplitError::InvalidLifecycle
        );
        require_keys_eq!(
            portfolio.deployment_legs[index].mint,
            portfolio.basket[index].mint,
            StockSplitError::DeploymentStateInvalid
        );
        require!(
            portfolio.deployment_legs[index].allocation_bps
                == portfolio.basket[index].allocation_bps,
            StockSplitError::DeploymentStateInvalid
        );
        require_keys_eq!(
            portfolio.basket[index].mint,
            ctx.accounts.output_mint.key(),
            StockSplitError::InvalidSwapMint
        );
        let intended_input_amount = deployment_input_amount(portfolio, index)?;
        require!(
            expected_input_amount == intended_input_amount,
            StockSplitError::InvalidDeploymentAmount
        );
        // All curated mock mints have six decimals. The fixed demo price is
        // precisely one output raw unit for one input raw unit.
        require!(
            min_output_amount == intended_input_amount,
            StockSplitError::InvalidSlippageBounds
        );
        if intended_input_amount == 0 {
            let leg = &mut portfolio.deployment_legs[index];
            leg.status = LEG_COMPLETED;
            leg.input_amount = 0;
            leg.output_amount = 0;
            portfolio.status = if portfolio
                .deployment_legs
                .iter()
                .all(|leg| leg.status == LEG_COMPLETED)
            {
                STATUS_ACTIVE
            } else {
                STATUS_DEPLOYING
            };
            return Ok(());
        }
        require_mint_usable_for_transfer(&ctx.accounts.input_mint.to_account_info(), Some(6))?;
        require_mint_usable_for_transfer(&ctx.accounts.output_mint.to_account_info(), Some(6))?;
        require_usable_token_account(
            &ctx.accounts.usdc_vault.to_account_info(),
            &ctx.accounts.usdc_vault,
            ctx.accounts.input_mint.key(),
            portfolio.key(),
            token_2022::ID,
        )?;
        require_usable_token_account(
            &ctx.accounts.output_vault.to_account_info(),
            &ctx.accounts.output_vault,
            ctx.accounts.output_mint.key(),
            portfolio.key(),
            token_2022::ID,
        )?;
        require_usable_token_account(
            &ctx.accounts.demo_usdc_sink.to_account_info(),
            &ctx.accounts.demo_usdc_sink,
            ctx.accounts.input_mint.key(),
            ctx.accounts.demo_authority.key(),
            token_2022::ID,
        )?;
        require_usable_token_account(
            &ctx.accounts.demo_output_liquidity.to_account_info(),
            &ctx.accounts.demo_output_liquidity,
            ctx.accounts.output_mint.key(),
            ctx.accounts.demo_authority.key(),
            token_2022::ID,
        )?;
        require!(
            ctx.accounts.usdc_vault.amount >= intended_input_amount,
            StockSplitError::InsufficientRecordedUsdc
        );
        require!(
            ctx.accounts.demo_output_liquidity.amount >= intended_input_amount,
            StockSplitError::SlippageExceeded
        );
        let input_before = ctx.accounts.usdc_vault.amount;
        let output_before = ctx.accounts.output_vault.amount;
        let portfolio_id_bytes = portfolio.portfolio_id.to_le_bytes();
        let portfolio_bump = [portfolio.bump];
        let portfolio_seeds: &[&[u8]] = &[
            PORTFOLIO_SEED,
            portfolio.creator.as_ref(),
            portfolio_id_bytes.as_ref(),
            &portfolio_bump,
        ];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.usdc_vault.to_account_info(),
                    mint: ctx.accounts.input_mint.to_account_info(),
                    to: ctx.accounts.demo_usdc_sink.to_account_info(),
                    authority: portfolio.to_account_info(),
                },
                &[portfolio_seeds],
            ),
            intended_input_amount,
            6,
        )?;
        let demo_bump = [ctx.bumps.demo_authority];
        let demo_seeds: &[&[u8]] = &[DEMO_AUTHORITY_SEED, &demo_bump];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.demo_output_liquidity.to_account_info(),
                    mint: ctx.accounts.output_mint.to_account_info(),
                    to: ctx.accounts.output_vault.to_account_info(),
                    authority: ctx.accounts.demo_authority.to_account_info(),
                },
                &[demo_seeds],
            ),
            intended_input_amount,
            6,
        )?;
        ctx.accounts.usdc_vault.reload()?;
        ctx.accounts.output_vault.reload()?;
        require!(
            input_before.checked_sub(ctx.accounts.usdc_vault.amount) == Some(intended_input_amount),
            StockSplitError::InvalidExecutedInputAmount
        );
        require!(
            ctx.accounts.output_vault.amount.checked_sub(output_before)
                == Some(intended_input_amount),
            StockSplitError::SlippageExceeded
        );
        let leg = &mut portfolio.deployment_legs[index];
        leg.status = LEG_COMPLETED;
        leg.input_amount = intended_input_amount;
        leg.output_amount = intended_input_amount;
        portfolio.status = if portfolio
            .deployment_legs
            .iter()
            .all(|leg| leg.status == LEG_COMPLETED)
        {
            STATUS_ACTIVE
        } else {
            STATUS_DEPLOYING
        };
        Ok(())
    }

    /// Withdraws one member's proportional share of every current portfolio
    /// vault, in kind. The member signs for their own exit; the portfolio PDA
    /// signs each vault transfer.
    pub fn withdraw_member<'info>(
        ctx: Context<'_, '_, '_, 'info, WithdrawMember<'info>>,
    ) -> Result<()> {
        let portfolio = &mut ctx.accounts.portfolio;
        require!(
            portfolio.status == STATUS_ACTIVE,
            StockSplitError::InvalidLifecycle
        );

        let member = &mut ctx.accounts.member;
        require!(
            member.withdrawal_status == 0,
            StockSplitError::WithdrawalAlreadyCompleted
        );
        let member_units = member.ownership_units;
        let total_units = portfolio.total_units;
        require!(
            member_units > 0 && member_units <= total_units && total_units > 0,
            StockSplitError::OwnershipAccountingInvariant
        );

        // Each asset is represented by exactly four ordered accounts:
        // vault, member destination, mint, token program. The first tuple is
        // the configured USDC vault; the remaining tuples follow basket order.
        let asset_count = portfolio
            .basket
            .len()
            .checked_add(1)
            .ok_or(StockSplitError::ArithmeticOverflow)?;
        let expected_account_count = asset_count
            .checked_mul(4)
            .ok_or(StockSplitError::ArithmeticOverflow)?;
        require!(
            ctx.remaining_accounts.len() == expected_account_count,
            StockSplitError::InvalidWithdrawalAccounts
        );

        let portfolio_id_bytes = portfolio.portfolio_id.to_le_bytes();
        let portfolio_bump = [portfolio.bump];
        let signer_seed_parts: &[&[u8]] = &[
            PORTFOLIO_SEED,
            portfolio.creator.as_ref(),
            portfolio_id_bytes.as_ref(),
            &portfolio_bump,
        ];
        let signer_seeds: &[&[&[u8]]] = &[signer_seed_parts];

        for asset_index in 0..asset_count {
            let account_offset = asset_index
                .checked_mul(4)
                .ok_or(StockSplitError::ArithmeticOverflow)?;
            let vault_info = &ctx.remaining_accounts[account_offset];
            let destination_info = &ctx.remaining_accounts[account_offset + 1];
            let mint_info = &ctx.remaining_accounts[account_offset + 2];
            let token_program_info = &ctx.remaining_accounts[account_offset + 3];

            let expected_mint = if asset_index == 0 {
                portfolio.usdc_mint
            } else {
                portfolio.basket[asset_index - 1].mint
            };
            let (expected_vault, _) = Pubkey::find_program_address(
                &[VAULT_SEED, portfolio.key().as_ref(), expected_mint.as_ref()],
                &crate::ID,
            );
            require_keys_eq!(
                *vault_info.key,
                expected_vault,
                StockSplitError::InvalidVault
            );
            require_keys_eq!(
                *mint_info.key,
                expected_mint,
                StockSplitError::InvalidWithdrawalAccounts
            );
            require!(
                vault_info.is_writable && destination_info.is_writable,
                StockSplitError::InvalidWithdrawalAccounts
            );
            require!(
                !mint_info.is_writable && !token_program_info.is_writable,
                StockSplitError::InvalidWithdrawalAccounts
            );
            require!(
                token_program_info.executable,
                StockSplitError::InvalidWithdrawalAccounts
            );

            let decimals = if asset_index == 0 {
                require_mint_usable_for_transfer(mint_info, Some(EXPECTED_TOKEN_DECIMALS))?
            } else {
                require_keys_eq!(
                    *mint_info.owner,
                    token_2022::ID,
                    StockSplitError::Token2022Required
                );
                require_mint_usable_for_transfer(mint_info, None)?
            };
            require_keys_eq!(
                *token_program_info.key,
                *mint_info.owner,
                StockSplitError::InvalidWithdrawalAccounts
            );
            require!(
                *token_program_info.key == token::ID || *token_program_info.key == token_2022::ID,
                StockSplitError::InvalidWithdrawalAccounts
            );

            let vault_account = deserialize_token_account(vault_info)?;
            require_usable_token_account(
                vault_info,
                &vault_account,
                expected_mint,
                portfolio.key(),
                *token_program_info.key,
            )?;
            let destination_account = deserialize_token_account(destination_info)?;
            require_usable_token_account(
                destination_info,
                &destination_account,
                expected_mint,
                member.wallet,
                *token_program_info.key,
            )?;

            let amount = withdrawal_entitlement(vault_account.amount, member_units, total_units)?;
            if amount > 0 {
                let transfer_accounts = TransferChecked {
                    from: vault_info.clone(),
                    mint: mint_info.clone(),
                    to: destination_info.clone(),
                    authority: portfolio.to_account_info(),
                };
                let transfer_ctx = CpiContext::new_with_signer(
                    token_program_info.clone(),
                    transfer_accounts,
                    signer_seeds,
                );
                token_interface::transfer_checked(transfer_ctx, amount, decimals)?;
            }
        }

        portfolio.total_units = total_units
            .checked_sub(member_units)
            .ok_or(StockSplitError::OwnershipAccountingInvariant)?;
        member.ownership_units = 0;
        member.withdrawal_status = 1;
        if portfolio.total_units == 0 {
            portfolio.status = STATUS_CLOSED;
        }
        Ok(())
    }

    /// Creates a deterministic vault for one configured USDC or basket mint.
    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        require_configured_vault_mint(&ctx.accounts.portfolio, ctx.accounts.mint.key())?;
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            *ctx.accounts.mint.to_account_info().owner,
            StockSplitError::InvalidMintAccount
        );
        if ctx.accounts.mint.key() == ctx.accounts.portfolio.usdc_mint {
            validate_usdc_mint(&ctx.accounts.mint.to_account_info())?;
        } else {
            validate_token_2022_mint(&ctx.accounts.mint.to_account_info(), None)?;
        }
        Ok(())
    }

    /// Deposits tokens from the signed wallet into the PDA-controlled vault.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.portfolio.usdc_mint == Pubkey::default(),
            StockSplitError::LegacyEntrypointDisabled
        );
        require!(amount > 0, StockSplitError::AmountMustBePositive);
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            token_2022::ID,
            StockSplitError::Token2022Required
        );

        let transfer_accounts = TransferChecked {
            from: ctx.accounts.source_token.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.depositor.to_account_info(),
        };
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            transfer_accounts,
        );
        token_interface::transfer_checked(transfer_ctx, amount, ctx.accounts.mint.decimals)
    }

    /// Phase 0 proof-only withdrawal.
    ///
    /// The creator must sign, but the token transfer is signed by the
    /// portfolio PDA. Phase 1 will replace this proof-only authorization with
    /// member-owned withdrawal accounting; no member accounting is present in
    /// this Phase 0 program.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.portfolio.usdc_mint == Pubkey::default(),
            StockSplitError::LegacyEntrypointDisabled
        );
        require!(amount > 0, StockSplitError::AmountMustBePositive);
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            token_2022::ID,
            StockSplitError::Token2022Required
        );

        let portfolio_id_bytes = ctx.accounts.portfolio.portfolio_id.to_le_bytes();
        let portfolio_bump = [ctx.accounts.portfolio.bump];
        let signer_seeds: &[&[u8]] = &[
            PORTFOLIO_SEED,
            ctx.accounts.portfolio.creator.as_ref(),
            portfolio_id_bytes.as_ref(),
            &portfolio_bump,
        ];
        let signer_seeds: &[&[&[u8]]] = &[signer_seeds];

        let transfer_accounts = TransferChecked {
            from: ctx.accounts.vault.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.destination_token.to_account_info(),
            authority: ctx.accounts.portfolio.to_account_info(),
        };
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            transfer_accounts,
            signer_seeds,
        );
        token_interface::transfer_checked(transfer_ctx, amount, ctx.accounts.mint.decimals)
    }
}

#[derive(Accounts)]
#[instruction(portfolio_id: u64)]
pub struct InitializePortfolio<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = 8 + Portfolio::INIT_SPACE,
        seeds = [PORTFOLIO_SEED, creator.key().as_ref(), portfolio_id.to_le_bytes().as_ref()],
        bump
    )]
    pub portfolio: Account<'info, Portfolio>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(portfolio_id: u64)]
pub struct CreatePortfolio<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = 8 + Portfolio::INIT_SPACE,
        seeds = [PORTFOLIO_SEED, creator.key().as_ref(), portfolio_id.to_le_bytes().as_ref()],
        bump
    )]
    pub portfolio: Account<'info, Portfolio>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreatorPortfolio<'info> {
    #[account(mut, address = portfolio.creator @ StockSplitError::Unauthorized)]
    pub creator: Signer<'info>,
    #[account(
        mut,
        seeds = [PORTFOLIO_SEED, portfolio.creator.as_ref(), portfolio.portfolio_id.to_le_bytes().as_ref()],
        bump = portfolio.bump
    )]
    pub portfolio: Account<'info, Portfolio>,
}

#[derive(Accounts)]
pub struct InviteMember<'info> {
    #[account(mut, address = portfolio.creator @ StockSplitError::Unauthorized)]
    pub creator: Signer<'info>,
    #[account(
        seeds = [PORTFOLIO_SEED, portfolio.creator.as_ref(), portfolio.portfolio_id.to_le_bytes().as_ref()],
        bump = portfolio.bump
    )]
    pub portfolio: Account<'info, Portfolio>,
    /// CHECK: The wallet is stored as the invited member identity and is not dereferenced.
    pub wallet: UncheckedAccount<'info>,
    #[account(
        init,
        payer = creator,
        space = 8 + Member::INIT_SPACE,
        seeds = [MEMBER_SEED, portfolio.key().as_ref(), wallet.key().as_ref()],
        bump
    )]
    pub member: Account<'info, Member>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Contribute<'info> {
    pub contributor: Signer<'info>,
    #[account(
        mut,
        seeds = [PORTFOLIO_SEED, portfolio.creator.as_ref(), portfolio.portfolio_id.to_le_bytes().as_ref()],
        bump = portfolio.bump
    )]
    pub portfolio: Account<'info, Portfolio>,
    #[account(
        mut,
        seeds = [MEMBER_SEED, portfolio.key().as_ref(), contributor.key().as_ref()],
        bump = member.bump,
        constraint = member.portfolio == portfolio.key() @ StockSplitError::UnauthorizedMember,
        constraint = member.wallet == contributor.key() @ StockSplitError::UnauthorizedMember
    )]
    pub member: Account<'info, Member>,
    #[account(address = portfolio.usdc_mint @ StockSplitError::InvalidUsdcMint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        constraint = source_token.mint == mint.key() @ StockSplitError::InvalidTokenAccount,
        constraint = source_token.owner == contributor.key() @ StockSplitError::InvalidTokenAccount
    )]
    pub source_token: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [VAULT_SEED, portfolio.key().as_ref(), portfolio.usdc_mint.as_ref()],
        bump,
        constraint = vault.mint == mint.key() @ StockSplitError::InvalidVault,
        constraint = vault.owner == portfolio.key() @ StockSplitError::InvalidVault
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct DeployLeg<'info> {
    /// Temporary Phase 2 execution gate. This is not a price oracle or a
    /// long-term member-fund trust model; independent route/price
    /// authorization is required before production deployment.
    #[account(address = portfolio.creator @ StockSplitError::Unauthorized)]
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [PORTFOLIO_SEED, portfolio.creator.as_ref(), portfolio.portfolio_id.to_le_bytes().as_ref()],
        bump = portfolio.bump
    )]
    pub portfolio: Account<'info, Portfolio>,
    #[account(address = portfolio.usdc_mint @ StockSplitError::InvalidUsdcMint)]
    pub input_mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        seeds = [VAULT_SEED, portfolio.key().as_ref(), portfolio.usdc_mint.as_ref()],
        bump,
        constraint = usdc_vault.mint == input_mint.key() @ StockSplitError::InvalidVault,
        constraint = usdc_vault.owner == portfolio.key() @ StockSplitError::InvalidVault
    )]
    pub usdc_vault: InterfaceAccount<'info, TokenAccount>,
    pub output_mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        seeds = [VAULT_SEED, portfolio.key().as_ref(), output_mint.key().as_ref()],
        bump,
        constraint = output_vault.mint == output_mint.key() @ StockSplitError::InvalidVault,
        constraint = output_vault.owner == portfolio.key() @ StockSplitError::InvalidVault
    )]
    pub output_vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub output_token_program: Interface<'info, TokenInterface>,
    /// CHECK: constrained to Jupiter V6 and invoked only after route/account validation.
    #[account(address = JUPITER_V6_PROGRAM_ID @ StockSplitError::UnsupportedSwapProgram)]
    pub jupiter_program: UncheckedAccount<'info>,
}

#[cfg(feature = "devnet-demo")]
#[derive(Accounts)]
pub struct PrepareDemoRouter<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(address = DEMO_USDC_MINT @ StockSplitError::InvalidUsdcMint)]
    pub input_mint: InterfaceAccount<'info, Mint>,
    #[account(constraint = is_approved_demo_output_mint(output_mint.key()) @ StockSplitError::InvalidSwapMint)]
    pub output_mint: InterfaceAccount<'info, Mint>,
    /// CHECK: PDA authority for the two fixed Devnet demo token vaults.
    #[account(seeds = [DEMO_AUTHORITY_SEED], bump)]
    pub demo_authority: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        seeds = [b"demo-sink", input_mint.key().as_ref()],
        bump,
        token::mint = input_mint,
        token::authority = demo_authority,
        token::token_program = token_program,
    )]
    pub demo_usdc_sink: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = payer,
        seeds = [b"demo-liquidity", output_mint.key().as_ref()],
        bump,
        token::mint = output_mint,
        token::authority = demo_authority,
        token::token_program = token_program,
    )]
    pub demo_output_liquidity: InterfaceAccount<'info, TokenAccount>,
    #[account(address = token_2022::ID @ StockSplitError::Token2022Required)]
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[cfg(feature = "devnet-demo")]
#[derive(Accounts)]
pub struct DeployDemoLeg<'info> {
    #[account(address = portfolio.creator @ StockSplitError::Unauthorized)]
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [PORTFOLIO_SEED, portfolio.creator.as_ref(), portfolio.portfolio_id.to_le_bytes().as_ref()],
        bump = portfolio.bump,
        constraint = portfolio.usdc_mint == DEMO_USDC_MINT @ StockSplitError::InvalidUsdcMint,
    )]
    pub portfolio: Box<Account<'info, Portfolio>>,
    #[account(address = DEMO_USDC_MINT @ StockSplitError::InvalidUsdcMint)]
    pub input_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        seeds = [VAULT_SEED, portfolio.key().as_ref(), input_mint.key().as_ref()],
        bump,
        constraint = usdc_vault.mint == input_mint.key() @ StockSplitError::InvalidVault,
        constraint = usdc_vault.owner == portfolio.key() @ StockSplitError::InvalidVault,
    )]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(constraint = is_approved_demo_output_mint(output_mint.key()) @ StockSplitError::InvalidSwapMint)]
    pub output_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        seeds = [VAULT_SEED, portfolio.key().as_ref(), output_mint.key().as_ref()],
        bump,
        constraint = output_vault.mint == output_mint.key() @ StockSplitError::InvalidVault,
        constraint = output_vault.owner == portfolio.key() @ StockSplitError::InvalidVault,
    )]
    pub output_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: PDA signs only the fixed demo liquidity transfer.
    #[account(seeds = [DEMO_AUTHORITY_SEED], bump)]
    pub demo_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"demo-sink", input_mint.key().as_ref()],
        bump,
        constraint = demo_usdc_sink.mint == input_mint.key() @ StockSplitError::InvalidVault,
        constraint = demo_usdc_sink.owner == demo_authority.key() @ StockSplitError::InvalidVault,
    )]
    pub demo_usdc_sink: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"demo-liquidity", output_mint.key().as_ref()],
        bump,
        constraint = demo_output_liquidity.mint == output_mint.key() @ StockSplitError::InvalidVault,
        constraint = demo_output_liquidity.owner == demo_authority.key() @ StockSplitError::InvalidVault,
    )]
    pub demo_output_liquidity: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = token_2022::ID @ StockSplitError::Token2022Required)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut, address = portfolio.creator @ StockSplitError::Unauthorized)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [PORTFOLIO_SEED, portfolio.creator.as_ref(), portfolio.portfolio_id.to_le_bytes().as_ref()],
        bump = portfolio.bump
    )]
    pub portfolio: Account<'info, Portfolio>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = payer,
        seeds = [VAULT_SEED, portfolio.key().as_ref(), mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = portfolio,
        token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub depositor: Signer<'info>,
    #[account(
        seeds = [PORTFOLIO_SEED, portfolio.creator.as_ref(), portfolio.portfolio_id.to_le_bytes().as_ref()],
        bump = portfolio.bump
    )]
    pub portfolio: Account<'info, Portfolio>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        constraint = source_token.mint == mint.key() @ StockSplitError::InvalidTokenAccount,
        constraint = source_token.owner == depositor.key() @ StockSplitError::InvalidTokenAccount
    )]
    pub source_token: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [VAULT_SEED, portfolio.key().as_ref(), mint.key().as_ref()],
        bump,
        constraint = vault.mint == mint.key() @ StockSplitError::InvalidVault,
        constraint = vault.owner == portfolio.key() @ StockSplitError::InvalidVault
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, address = portfolio.creator @ StockSplitError::Unauthorized)]
    pub creator: Signer<'info>,
    #[account(
        seeds = [PORTFOLIO_SEED, portfolio.creator.as_ref(), portfolio.portfolio_id.to_le_bytes().as_ref()],
        bump = portfolio.bump
    )]
    pub portfolio: Account<'info, Portfolio>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        seeds = [VAULT_SEED, portfolio.key().as_ref(), mint.key().as_ref()],
        bump,
        constraint = vault.mint == mint.key() @ StockSplitError::InvalidVault,
        constraint = vault.owner == portfolio.key() @ StockSplitError::InvalidVault
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        constraint = destination_token.mint == mint.key() @ StockSplitError::InvalidTokenAccount
    )]
    pub destination_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct WithdrawMember<'info> {
    pub member_wallet: Signer<'info>,
    #[account(
        mut,
        seeds = [PORTFOLIO_SEED, portfolio.creator.as_ref(), portfolio.portfolio_id.to_le_bytes().as_ref()],
        bump = portfolio.bump
    )]
    pub portfolio: Account<'info, Portfolio>,
    #[account(
        mut,
        seeds = [MEMBER_SEED, portfolio.key().as_ref(), member_wallet.key().as_ref()],
        bump = member.bump,
        constraint = member.portfolio == portfolio.key() @ StockSplitError::UnauthorizedMember,
        constraint = member.wallet == member_wallet.key() @ StockSplitError::UnauthorizedMember
    )]
    pub member: Account<'info, Member>,
}

#[derive(Accounts)]
pub struct RefundMember<'info> {
    pub member_wallet: Signer<'info>,
    #[account(
        mut,
        seeds = [PORTFOLIO_SEED, portfolio.creator.as_ref(), portfolio.portfolio_id.to_le_bytes().as_ref()],
        bump = portfolio.bump
    )]
    pub portfolio: Box<Account<'info, Portfolio>>,
    #[account(
        mut,
        seeds = [MEMBER_SEED, portfolio.key().as_ref(), member_wallet.key().as_ref()],
        bump = member.bump,
        constraint = member.portfolio == portfolio.key() @ StockSplitError::UnauthorizedMember,
        constraint = member.wallet == member_wallet.key() @ StockSplitError::UnauthorizedMember
    )]
    pub member: Box<Account<'info, Member>>,
    #[account(address = portfolio.usdc_mint @ StockSplitError::InvalidUsdcMint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        seeds = [VAULT_SEED, portfolio.key().as_ref(), portfolio.usdc_mint.as_ref()],
        bump,
        constraint = usdc_vault.mint == usdc_mint.key() @ StockSplitError::InvalidVault,
        constraint = usdc_vault.owner == portfolio.key() @ StockSplitError::InvalidVault
    )]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = destination_token.mint == usdc_mint.key() @ StockSplitError::InvalidRefundDestination,
        constraint = destination_token.owner == member_wallet.key() @ StockSplitError::InvalidRefundDestination
    )]
    pub destination_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[account]
#[derive(InitSpace)]
pub struct Portfolio {
    pub creator: Pubkey,
    pub portfolio_id: u64,
    pub bump: u8,
    pub status: u8,
    pub funding_start: i64,
    pub funding_deadline: i64,
    pub target_usdc: u64,
    pub usdc_mint: Pubkey,
    pub total_units: u64,
    pub total_contributed: u64,
    pub basket_locked: bool,
    pub ownership_locked: bool,
    pub funding_closed_at: i64,
    #[max_len(64)]
    pub name: String,
    #[max_len(256)]
    pub description: String,
    #[max_len(8)]
    pub basket: Vec<BasketAsset>,
    #[max_len(8)]
    pub deployment_legs: Vec<DeploymentLeg>,
    // Reserved for future deployment/holding metadata.
    #[max_len(1024)]
    pub phase2_reserved: Vec<u8>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct BasketAsset {
    pub mint: Pubkey,
    pub allocation_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct DeploymentLeg {
    pub mint: Pubkey,
    pub allocation_bps: u16,
    pub status: u8,
    pub input_amount: u64,
    pub output_amount: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Member {
    pub portfolio: Pubkey,
    pub wallet: Pubkey,
    pub bump: u8,
    pub total_contributed: u64,
    pub ownership_units: u64,
    pub withdrawal_status: u8,
    // Reserved for future withdrawal/deployment metadata.
    #[max_len(128)]
    pub phase2_reserved: Vec<u8>,
}

#[error_code]
pub enum StockSplitError {
    #[msg("This Phase 0 proof requires the Token-2022 program")]
    Token2022Required,
    #[msg("Token amount must be positive")]
    AmountMustBePositive,
    #[msg("Token account does not belong to the expected wallet or mint")]
    InvalidTokenAccount,
    #[msg("Vault does not belong to this portfolio or mint")]
    InvalidVault,
    #[msg("Only the portfolio creator may invoke the Phase 0 withdrawal proof")]
    Unauthorized,
    #[msg("Portfolio metadata exceeds the supported account size")]
    MetadataTooLong,
    #[msg("Funding start must be before the funding deadline")]
    InvalidFundingWindow,
    #[msg("Funding target must be positive")]
    InvalidTarget,
    #[msg("Basket must contain between one and eight unique assets")]
    InvalidBasket,
    #[msg("Basket allocations must total exactly 10000 basis points")]
    InvalidAllocation,
    #[msg("Basket contains the same asset more than once")]
    DuplicateBasketAsset,
    #[msg("Arithmetic operation overflowed")]
    ArithmeticOverflow,
    #[msg("Portfolio is not in the required lifecycle state")]
    InvalidLifecycle,
    #[msg("Funding has not opened yet")]
    FundingNotOpen,
    #[msg("The funding deadline has passed")]
    FundingWindowExpired,
    #[msg("Funding is already closed")]
    FundingClosed,
    #[msg("The contribution would exceed the funding target")]
    TargetExceeded,
    #[msg("The funding window is not ready to close")]
    FundingNotReadyToClose,
    #[msg("Invalid member wallet")]
    InvalidMember,
    #[msg("Wallet is not an invited member of this portfolio")]
    UnauthorizedMember,
    #[msg("The contribution mint does not match the portfolio USDC mint")]
    InvalidUsdcMint,
    #[msg("The mint account is invalid or cannot be decoded as a Token-2022 mint")]
    InvalidMintAccount,
    #[msg("The mint does not use the expected six decimals")]
    InvalidMintDecimals,
    #[msg("The mint uses an unsupported Token-2022 extension")]
    UnsupportedMintExtension,
    #[msg("A declared basket mint account is missing or does not match the basket")]
    InvalidBasketMint,
    #[msg("Portfolio ownership accounting invariant was violated")]
    OwnershipAccountingInvariant,
    #[msg("The vault balance decreased during contribution settlement")]
    VaultBalanceDecreased,
    #[msg("The vault did not receive exactly the requested contribution amount")]
    ContributionAmountMismatch,
    #[msg("A portfolio with zero ownership units cannot close funding")]
    ZeroFundedClose,
    #[msg("The vault mint is not the configured USDC or a declared basket mint")]
    InvalidVaultMint,
    #[msg("This legacy Phase 0 entrypoint is disabled for Phase 1 portfolios")]
    LegacyEntrypointDisabled,
    #[msg("The token account is frozen or otherwise unavailable")]
    TokenAccountUnavailable,
    #[msg("The token mint is paused or otherwise unavailable")]
    TokenMintUnavailable,
    #[msg("The requested deployment leg is invalid")]
    InvalidDeploymentLeg,
    #[msg("Deployment state does not match the immutable basket")]
    DeploymentStateInvalid,
    #[msg("This deployment leg has already completed")]
    DeploymentAlreadyCompleted,
    #[msg("The deployment input amount does not match recorded allocation")]
    InvalidDeploymentAmount,
    #[msg("Requested slippage exceeds the supported limit")]
    SlippageTooHigh,
    #[msg("The quote and minimum output bounds are invalid")]
    InvalidSlippageBounds,
    #[msg("The recorded USDC balance cannot fund this deployment leg")]
    InsufficientRecordedUsdc,
    #[msg("The supplied instruction is not an approved Jupiter route instruction")]
    InvalidSwapInstruction,
    #[msg("The supplied Jupiter route accounts are invalid")]
    InvalidSwapAccounts,
    #[msg("The supplied Jupiter route authority is invalid")]
    InvalidSwapAuthority,
    #[msg("The supplied Jupiter route source is invalid")]
    InvalidSwapSource,
    #[msg("The supplied Jupiter route destination is invalid")]
    InvalidSwapDestination,
    #[msg("The supplied swap mint is invalid")]
    InvalidSwapMint,
    #[msg("The Jupiter route CPI failed")]
    JupiterSwapFailed,
    #[msg("The source vault balance increased during deployment")]
    InputBalanceIncreased,
    #[msg("The destination vault balance decreased during deployment")]
    OutputBalanceDecreased,
    #[msg("The executed input amount did not match the intended amount")]
    InvalidExecutedInputAmount,
    #[msg("The executed swap output was below the protected minimum")]
    SlippageExceeded,
    #[msg("The supplied swap program is not the approved Jupiter V6 program")]
    UnsupportedSwapProgram,
    #[msg("The supplied Jupiter V2 route uses a fee that this deployment does not authorize")]
    UnsupportedSwapFee,
    #[msg("The supplied Jupiter route plan uses an unsupported swap payload variant")]
    UnsupportedRoutePlanVariant,
    #[msg("Withdrawal account order or privileges are invalid")]
    InvalidWithdrawalAccounts,
    #[msg("This member has already withdrawn from the portfolio")]
    WithdrawalAlreadyCompleted,
    #[msg("A deployment leg has already executed; cancellation is unavailable")]
    DeploymentAlreadyStarted,
    #[msg("This member has already claimed the cancelled portfolio refund")]
    RefundAlreadyCompleted,
    #[msg("This member has no recorded USDC contribution to refund")]
    NoRefundAvailable,
    #[msg("The member state cannot claim a cancelled portfolio refund")]
    InvalidRefundState,
    #[msg("Refund destination must be the member's canonical USDC account")]
    InvalidRefundDestination,
    #[msg("The canonical USDC vault cannot cover the recorded refund")]
    InsufficientRefundVaultBalance,
    #[msg("The refund did not move the exact recorded USDC amount")]
    RefundAmountMismatch,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn portfolio_with_allocations(
        total_contributed: u64,
        allocations: &[(u16, Pubkey)],
    ) -> Portfolio {
        Portfolio {
            creator: Pubkey::default(),
            portfolio_id: 0,
            bump: 0,
            status: STATUS_FUNDING_CLOSED,
            funding_start: 0,
            funding_deadline: 0,
            target_usdc: total_contributed,
            usdc_mint: Pubkey::default(),
            total_units: total_contributed,
            total_contributed,
            basket_locked: true,
            ownership_locked: true,
            funding_closed_at: 1,
            name: String::new(),
            description: String::new(),
            basket: allocations
                .iter()
                .map(|(allocation_bps, mint)| BasketAsset {
                    mint: *mint,
                    allocation_bps: *allocation_bps,
                })
                .collect(),
            deployment_legs: Vec::new(),
            phase2_reserved: Vec::new(),
        }
    }

    #[test]
    fn deployment_allocations_use_recorded_contribution_and_last_leg_remainder() {
        let portfolio = portfolio_with_allocations(
            10_000_000,
            &[
                (4_000, Pubkey::new_unique()),
                (3_333, Pubkey::new_unique()),
                (2_667, Pubkey::new_unique()),
            ],
        );

        assert_eq!(deployment_input_amount(&portfolio, 0).unwrap(), 4_000_000);
        assert_eq!(deployment_input_amount(&portfolio, 1).unwrap(), 3_333_000);
        assert_eq!(deployment_input_amount(&portfolio, 2).unwrap(), 2_667_000);
        assert_eq!(
            deployment_input_amount(&portfolio, 0).unwrap()
                + deployment_input_amount(&portfolio, 1).unwrap()
                + deployment_input_amount(&portfolio, 2).unwrap(),
            portfolio.total_contributed
        );
    }

    #[test]
    fn deployment_rounding_is_paid_by_the_last_leg_only() {
        let portfolio = portfolio_with_allocations(
            7,
            &[
                (3_333, Pubkey::new_unique()),
                (3_333, Pubkey::new_unique()),
                (3_334, Pubkey::new_unique()),
            ],
        );

        assert_eq!(deployment_input_amount(&portfolio, 0).unwrap(), 2);
        assert_eq!(deployment_input_amount(&portfolio, 1).unwrap(), 2);
        assert_eq!(deployment_input_amount(&portfolio, 2).unwrap(), 3);
    }

    #[test]
    fn completed_deployment_legs_cannot_be_executed_again() {
        let leg = DeploymentLeg {
            mint: Pubkey::new_unique(),
            allocation_bps: 10_000,
            status: LEG_COMPLETED,
            input_amount: 1,
            output_amount: 1,
        };

        assert!(require_pending_leg(&leg).is_err());
    }

    #[test]
    fn withdrawal_entitlement_uses_current_raw_balance_and_floor_rounding() {
        assert_eq!(
            withdrawal_entitlement(10_000_003, 4, 10).unwrap(),
            4_000_001
        );
        assert_eq!(withdrawal_entitlement(7, 2, 3).unwrap(), 4);
        // Once one member is the entire remaining owner, raw dust is theirs.
        assert_eq!(withdrawal_entitlement(7, 1, 1).unwrap(), 7);
        assert!(withdrawal_entitlement(1, 0, 1).is_err());
        assert!(withdrawal_entitlement(1, 2, 1).is_err());
    }

    fn current_route_data(shared: bool) -> Vec<u8> {
        let discriminator = if shared {
            JUPITER_SHARED_ACCOUNTS_ROUTE_V2_CURRENT_DISCRIMINATOR
        } else {
            JUPITER_ROUTE_V2_DISCRIMINATOR
        };
        let mut data = discriminator.to_vec();
        if shared {
            // The live /build SharedAccountsRouteV2 payload includes its
            // one-byte route id before the common exact-in arguments.
            data.push(1);
        }
        data.extend_from_slice(&1_000_000u64.to_le_bytes());
        data.extend_from_slice(&977_021u64.to_le_bytes());
        data.extend_from_slice(&50u16.to_le_bytes());
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&(if shared { 2u32 } else { 1u32 }).to_le_bytes());
        data.push(156);
        data.extend_from_slice(&10_000u16.to_le_bytes());
        data.push(0);
        data.push(1);
        if shared {
            data.push(156);
            data.extend_from_slice(&10_000u16.to_le_bytes());
            data.push(0);
            data.push(1);
        }
        data
    }

    #[test]
    fn decodes_live_route_v2_and_shared_accounts_route_v2_payloads_exactly() {
        let route = decode_jupiter_v2(&current_route_data(false)).unwrap();
        assert_eq!(route.variant, JupiterV2Variant::RouteV2);
        assert_eq!(route.in_amount, 1_000_000);
        assert_eq!(route.quoted_out_amount, 977_021);
        assert_eq!(route.slippage_bps, 50);
        assert_eq!(route.platform_fee_bps, 0);
        assert_eq!(route.positive_slippage_bps, 0);

        let shared = decode_jupiter_v2(&current_route_data(true)).unwrap();
        assert_eq!(shared.variant, JupiterV2Variant::SharedAccountsRouteV2);
        assert_eq!(shared.route_id, Some(1));
        assert_eq!(shared.in_amount, 1_000_000);
        assert_eq!(shared.quoted_out_amount, 977_021);
    }

    fn current_whirlpool_route_data(optional_tag: Option<u8>) -> Vec<u8> {
        let mut data = JUPITER_ROUTE_V2_DISCRIMINATOR.to_vec();
        data.extend_from_slice(&1_000_000u64.to_le_bytes());
        data.extend_from_slice(&977_021u64.to_le_bytes());
        data.extend_from_slice(&50u16.to_le_bytes());
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&1u32.to_le_bytes());
        data.push(0x2f);
        data.push(1); // WhirlpoolSwapV2 a_to_b
        if let Some(tag) = optional_tag {
            data.push(tag);
        }
        data.extend_from_slice(&10_000u16.to_le_bytes());
        data.push(0);
        data.push(1);
        data
    }

    #[test]
    fn decodes_current_whirlpool_swap_v2_none_payload_exactly() {
        let route = decode_jupiter_v2(&current_whirlpool_route_data(Some(0))).unwrap();
        assert_eq!(route.in_amount, 1_000_000);
        assert_eq!(route.quoted_out_amount, 977_021);
    }

    #[test]
    fn rejects_malformed_whirlpool_optional_data_and_unknown_variants() {
        let mut missing_boolean = current_whirlpool_route_data(Some(0));
        missing_boolean.remove(36);
        assert!(decode_jupiter_v2(&missing_boolean).is_err());

        let some_accounts = decode_jupiter_v2(&current_whirlpool_route_data(Some(1)));
        assert!(some_accounts.is_err());

        let invalid_option = decode_jupiter_v2(&current_whirlpool_route_data(Some(2)));
        assert!(invalid_option.is_err());

        let mut trailing = current_whirlpool_route_data(Some(0));
        trailing.push(0);
        assert!(decode_jupiter_v2(&trailing).is_err());

        let mut unknown = current_whirlpool_route_data(Some(0));
        // The route-plan variant is the first byte after the common header.
        unknown[34] = 0xb9;
        assert!(decode_jupiter_v2(&unknown).is_err());

        let mut legacy_shared = current_route_data(true);
        legacy_shared[..8].copy_from_slice(&[123, 141, 210, 115, 241, 229, 15, 101]);
        assert!(decode_jupiter_v2(&legacy_shared).is_err());
    }

    #[test]
    fn validates_dynamic_route_repetitions_by_privilege() {
        let portfolio = Pubkey::new_unique();
        let usdc_vault = Pubkey::new_unique();
        let output_vault = Pubkey::new_unique();

        for key in [portfolio, usdc_vault, output_vault] {
            assert!(validate_dynamic_route_account(DynamicRouteAccount {
                key,
                is_signer: false,
            })
            .is_ok());
        }

        for account in [
            DynamicRouteAccount {
                key: Pubkey::default(),
                is_signer: false,
            },
            DynamicRouteAccount {
                key: Pubkey::new_unique(),
                is_signer: true,
            },
        ] {
            assert!(validate_dynamic_route_account(account).is_err());
        }
    }

    #[test]
    fn rejects_active_transfer_hook() {
        assert!(require_disabled_transfer_hook(None).is_ok());
        assert!(require_disabled_transfer_hook(Some(Pubkey::new_unique())).is_err());
    }

    #[test]
    fn rejects_paused_mint() {
        assert!(require_unpaused_mint(false).is_ok());
        assert!(require_unpaused_mint(true).is_err());
    }

    #[test]
    fn rejects_frozen_default_and_token_accounts() {
        assert!(require_default_account_initialized(AccountState::Initialized as u8).is_ok());
        assert!(require_default_account_initialized(AccountState::Frozen as u8).is_err());
        assert!(require_initialized_token_account_state(AccountState::Initialized).is_ok());
        assert!(require_initialized_token_account_state(AccountState::Frozen).is_err());
    }

    #[test]
    fn decodes_captured_current_build_fixtures() {
        let route_fixture = vec![
            0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14, 0x40, 0x42, 0x0f, 0x00, 0x00, 0x00,
            0x00, 0x00, 0xe3, 0x15, 0x95, 0x00, 0x00, 0x00, 0x00, 0x00, 0x32, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x7d, 0x01, 0x10, 0x27, 0x00, 0x01,
        ];
        let route = decode_jupiter_v2(&route_fixture).unwrap();
        assert_eq!(route.variant, JupiterV2Variant::RouteV2);
        assert_eq!(route.in_amount, 1_000_000);
        assert_eq!(route.quoted_out_amount, 9_770_467);
        assert_eq!(route.route_id, None);

        let shared_fixture = vec![
            0xd1, 0x98, 0x53, 0x93, 0x7c, 0xfe, 0xd8, 0xe9, 0x01, 0x40, 0x42, 0x0f, 0x00, 0x00,
            0x00, 0x00, 0x00, 0xe9, 0x14, 0x95, 0x00, 0x00, 0x00, 0x00, 0x00, 0x32, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x9c, 0x10, 0x27, 0x00, 0x01, 0x9c, 0x10,
            0x27, 0x01, 0x02,
        ];
        let shared = decode_jupiter_v2(&shared_fixture).unwrap();
        assert_eq!(shared.variant, JupiterV2Variant::SharedAccountsRouteV2);
        assert_eq!(shared.route_id, Some(1));
        assert_eq!(shared.in_amount, 1_000_000);
        assert_eq!(shared.quoted_out_amount, 9_770_217);
    }

    #[test]
    fn decodes_captured_real_usdc_to_nvdax_build_route() {
        let fixture_data = vec![
            0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14, 0x40, 0x42, 0x0f, 0x00, 0x00, 0x00,
            0x00, 0x00, 0xe5, 0x2a, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x32, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x10, 0x27, 0x00, 0x01,
        ];
        let route = decode_jupiter_v2(&fixture_data).unwrap();
        assert_eq!(route.variant, JupiterV2Variant::RouteV2);
        assert_eq!(route.in_amount, 1_000_000);
        assert_eq!(route.quoted_out_amount, 469_733);
        assert_eq!(route.slippage_bps, 50);
        assert_eq!(route.platform_fee_bps, 0);
        assert_eq!(route.positive_slippage_bps, 0);
    }

    #[test]
    fn rejects_jupiter_trailing_bytes_and_unauthorized_fees() {
        let mut trailing = current_route_data(false);
        trailing.push(0);
        assert!(decode_jupiter_v2(&trailing).is_err());

        let mut fee_data = current_route_data(false);
        fee_data[26] = 1;
        let args = decode_jupiter_v2(&fee_data).unwrap();
        assert_ne!(args.platform_fee_bps, 0);
    }
}
