import './index.css'

const ALLOWED_ATTRIBUTE_TYPES = {
    mobile: ['sidn.sidn-pbdf.mobilenumber.mobilenumber'],
    personalData: [
        'pbdf.gemeente.personalData.initials',
        'pbdf.gemeente.personalData.firstnames',
        'pbdf.gemeente.personalData.prefix',
        'pbdf.gemeente.personalData.familyname',
        'pbdf.gemeente.personalData.fullname',
        'pbdf.gemeente.personalData.gender',
        'pbdf.gemeente.personalData.nationality',
        'pbdf.gemeente.personalData.surname',
        'pbdf.gemeente.personalData.dateofbirth',
        'pbdf.gemeente.personalData.cityofbirth',
        'pbdf.gemeente.personalData.countryofbirth',
        'pbdf.gemeente.personalData.over12',
        'pbdf.gemeente.personalData.over16',
        'pbdf.gemeente.personalData.over18',
        'pbdf.gemeente.personalData.over21',
        'pbdf.gemeente.personalData.over65',
        'pbdf.gemeente.personalData.bsn',
        'pbdf.gemeente.personalData.digidlevel',
    ],
}

window.addEventListener('load', onLoad)

// TODO: receive updates about the recipients

async function onLoad() {
    const data = await browser.runtime.sendMessage({
        command: 'popup_init',
    })
    console.log('initial data: ', data)

    // TODO: populate a form

    document.addEventListener('onClick', () => {
        // collect policies
        browser.runtime
            .sendMessage({
                command: 'popup_done',
                policies: {},
            })
            .finally(() =>
                setTimeout(async () => {
                    const win = await messenger.windows.getCurrent()
                    messenger.windows.remove(win.id)
                }, 750)
            )
    })
}

window.addEventListener('load', onLoad)
