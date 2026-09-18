use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
};

solana_program::declare_id!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

const ROUTE_V2_DISCRIMINATOR: [u8; 8] = [187, 100, 250, 204, 49, 196, 175, 20];
const WHIRLPOOL_SWAP_V2_VARIANT: u8 = 0x2f;
const TRANSFER_CHECKED_TAG: u8 = 12;

entrypoint!(process_instruction);

fn mint_decimals<'a>(mint: &AccountInfo<'a>) -> Result<u8, ProgramError> {
    let data = mint.try_borrow_data()?;
    data.get(44)
        .copied()
        .ok_or(ProgramError::InvalidAccountData)
}

fn transfer_checked<'a>(
    token_program: &AccountInfo<'a>,
    source: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    amount: u64,
) -> ProgramResult {
    let decimals = mint_decimals(mint)?;
    let mut data = Vec::with_capacity(10);
    data.push(TRANSFER_CHECKED_TAG);
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);

    let instruction = Instruction {
        program_id: *token_program.key,
        accounts: vec![
            AccountMeta::new(*source.key, false),
            AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new(*destination.key, false),
            AccountMeta::new_readonly(*authority.key, true),
        ],
        data,
    };

    invoke(
        &instruction,
        &[
            token_program.clone(),
            source.clone(),
            mint.clone(),
            destination.clone(),
            authority.clone(),
        ],
    )
}

fn process_instruction<'a>(
    program_id: &Pubkey,
    accounts: &[AccountInfo<'a>],
    data: &[u8],
) -> ProgramResult {
    if program_id != &id() {
        return Err(ProgramError::IncorrectProgramId);
    }
    if data.len() != 41
        || data.get(..8) != Some(ROUTE_V2_DISCRIMINATOR.as_slice())
        || accounts.len() != 15
    {
        return Err(ProgramError::InvalidInstructionData);
    }
    if data[34] != WHIRLPOOL_SWAP_V2_VARIANT {
        return Err(ProgramError::InvalidInstructionData);
    }

    let account_iter = &mut accounts.iter();
    let authority = account_iter
        .next()
        .ok_or(ProgramError::NotEnoughAccountKeys)?;
    let source = account_iter
        .next()
        .ok_or(ProgramError::NotEnoughAccountKeys)?;
    let destination = account_iter
        .next()
        .ok_or(ProgramError::NotEnoughAccountKeys)?;
    let input_mint = account_iter
        .next()
        .ok_or(ProgramError::NotEnoughAccountKeys)?;
    let output_mint = account_iter
        .next()
        .ok_or(ProgramError::NotEnoughAccountKeys)?;
    let input_token_program = account_iter
        .next()
        .ok_or(ProgramError::NotEnoughAccountKeys)?;
    let output_token_program = account_iter
        .next()
        .ok_or(ProgramError::NotEnoughAccountKeys)?;
    let repeated_portfolio = accounts.get(10).ok_or(ProgramError::NotEnoughAccountKeys)?;
    let repeated_usdc_vault = accounts.get(11).ok_or(ProgramError::NotEnoughAccountKeys)?;
    let repeated_output_vault = accounts.get(12).ok_or(ProgramError::NotEnoughAccountKeys)?;
    let output_liquidity = accounts.get(13).ok_or(ProgramError::NotEnoughAccountKeys)?;
    let input_sink = accounts.get(14).ok_or(ProgramError::NotEnoughAccountKeys)?;
    let authority_key = *authority.key;

    // The production program must sanitize the duplicated outer portfolio
    // account before this CPI: the router expects authority index 0 to be a
    // read-only signer, while both token source/destination accounts remain
    // writable. No other route account may receive signer privilege.
    if !authority.is_signer
        || authority.is_writable
        || !source.is_writable
        || !destination.is_writable
        || *repeated_portfolio.key != authority_key
        || *repeated_usdc_vault.key != *source.key
        || *repeated_output_vault.key != *destination.key
        || repeated_portfolio.is_writable
        || !repeated_usdc_vault.is_writable
        || !repeated_output_vault.is_writable
        || !output_liquidity.is_writable
        || !input_sink.is_writable
        || accounts.iter().enumerate().any(|(index, account)| {
            // Signer privilege is also merged by pubkey. A repeated
            // portfolio occurrence may therefore report signer=true;
            // non-portfolio route accounts must never do so.
            account.is_signer && index != 0 && *account.key != authority_key
        })
    {
        return Err(ProgramError::InvalidAccountData);
    }

    let input_amount = u64::from_le_bytes(
        data[8..16]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let output_amount = u64::from_le_bytes(
        data[16..24]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );

    transfer_checked(
        input_token_program,
        source,
        input_mint,
        input_sink,
        authority,
        input_amount,
    )?;
    transfer_checked(
        output_token_program,
        output_liquidity,
        output_mint,
        destination,
        authority,
        output_amount,
    )?;

    // The failure form deliberately occurs after both CPIs. Solana atomicity
    // must roll back both transfers and the caller's deployment state.
    if data[35] == 1 {
        return Err(ProgramError::Custom(1));
    }

    Ok(())
}
